(() => {
  'use strict';

  const REQ = 'HBGBZX_PAGE_REQUEST';
  const RES = 'HBGBZX_PAGE_RESPONSE';
  const DEFAULTS = { speedRate: 1.5, enableAlert: true, alertTimeout: 2 };

  let settings = { ...DEFAULTS };
  let isAutoLearning = false;
  let learningToken = 0;
  let pauseTimer = null;
  let resumeTimer = null;
  let flashTimer = null;
  let originalTitle = '';
  let lastRateAt = 0;
  let dialogObserver = null;
  let rateKeepaliveTimer = null;
  let playbackStatusTimer = null;
  let playbackHealth = { lastTime: 0, lastAdvanceAt: 0, nudging: false, lastNudgeAt: 0 };
  let sectionState = { key: '', completionSent: false };

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isVideoPage = () => location.hash.includes('video_detail');
  const getVideo = () => document.querySelector('video');
  const clampRate = value => Math.max(1, Math.min(1.5, Number(value) || 1.5));

  function injectBridge() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('stealth.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (_) {}
  }

  function bridge(action, payload = {}, timeout = 2000) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        document.removeEventListener(RES, onResponse);
        reject(new Error(`bridge timeout: ${action}`));
      }, timeout);
      const onResponse = event => {
        const detail = event.detail || {};
        if (detail.id !== id) return;
        clearTimeout(timer);
        document.removeEventListener(RES, onResponse);
        if (!detail.result?.ok) {
          reject(new Error(detail.result?.message || `bridge failed: ${action}`));
          return;
        }
        resolve(detail.result.data);
      };
      document.addEventListener(RES, onResponse);
      document.dispatchEvent(new CustomEvent(REQ, { detail: { id, action, payload } }));
    });
  }

  function loadSettings() {
    chrome.storage.local.get(DEFAULTS, saved => {
      settings.speedRate = clampRate(saved.speedRate);
      settings.enableAlert = saved.enableAlert !== false;
      settings.alertTimeout = Number(saved.alertTimeout) > 0 ? Number(saved.alertTimeout) : DEFAULTS.alertTimeout;
    });
  }

  function restOverlay() {
    return document.getElementById('hbgbzx-rest-overlay');
  }

  function hideRestOverlay() {
    restOverlay()?.remove();
  }

  function showRestOverlay(state) {
    if (!document.body) return;
    const existing = restOverlay();
    const box = existing || document.createElement('div');
    if (!existing) {
      box.id = 'hbgbzx-rest-overlay';
      box.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483646;max-width:320px;background:rgba(23,32,42,.92);color:#fff;border-radius:14px;padding:16px 18px;box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:"Microsoft YaHei",sans-serif;line-height:1.6;pointer-events:none;';
      document.body.appendChild(box);
    }
    const minutes = Number(state?.restMinutesLeft || 0);
    const minuteText = minutes > 0 ? `${minutes} 分钟后继续学习` : '不足1分钟后继续学习';
    box.innerHTML = `
      <div style="font-size:16px;font-weight:700;margin-bottom:6px;">☕ 休息中</div>
      <div style="font-size:13px;opacity:.92;">当前课程已结束，插件正在按设定休息。</div>
      <div style="font-size:14px;font-weight:600;margin-top:8px;color:#ffd166;">预计 ${minuteText}</div>
      <div style="font-size:12px;opacity:.78;margin-top:4px;">提示按分钟更新，减少对网页的影响。</div>`;
    box.dataset.restUntil = String(state?.restUntil || 0);
  }

  function syncRestOverlay(state) {
    if (state?.status === 'RESTING') showRestOverlay(state);
    else hideRestOverlay();
  }

  chrome.storage.onChanged.addListener(changes => {
    if (changes.speedRate) settings.speedRate = clampRate(changes.speedRate.newValue);
    if (changes.enableAlert) settings.enableAlert = changes.enableAlert.newValue !== false;
    if (changes.alertTimeout) settings.alertTimeout = Number(changes.alertTimeout.newValue) > 0 ? Number(changes.alertTimeout.newValue) : DEFAULTS.alertTimeout;
    if (changes.autoLearnState) syncRestOverlay(changes.autoLearnState.newValue);
    if (isVideoPage()) applyPlaybackRate(true);
  });

  async function videoState() {
    try { return await bridge('getVideoState'); } catch (_) { return null; }
  }

  async function applyPlaybackRate(force = false) {
    if (!isVideoPage()) return false;
    const video = getVideo();
    if (!video) return false;
    const now = Date.now();
    if (!force && now - lastRateAt < 800 && Math.abs(video.playbackRate - settings.speedRate) < 0.01) return true;
    lastRateAt = now;
    try {
      await bridge('setPlaybackRate', { rate: settings.speedRate }, 2500);
      return true;
    } catch (_) {
      try { video.playbackRate = settings.speedRate; } catch (_) {}
      return false;
    }
  }

  async function resumeVideo(video = getVideo()) {
    if (!video) return false;
    if (video.ended) return false;
    if (!video.paused) return false;
    try {
      await bridge('resumePlayback', {}, 3000);
      return true;
    } catch (_) {
      try {
        video.muted = true;
        await video.play();
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  function clearPauseState() {
    if (pauseTimer) clearTimeout(pauseTimer);
    if (resumeTimer) clearTimeout(resumeTimer);
    pauseTimer = null;
    resumeTimer = null;
  }

  function startRateKeepalive() {
    if (rateKeepaliveTimer) return;
    rateKeepaliveTimer = setInterval(() => {
      if (!isAutoLearning || !isVideoPage()) return;
      applyPlaybackRate();
      const v = getVideo();
      if (v && v.paused && !v.ended) nudgePlayback('paused');
      else inspectPlaybackHealth();
    }, 2500);
  }

  function stopRateKeepalive() {
    if (!rateKeepaliveTimer) return;
    clearInterval(rateKeepaliveTimer);
    rateKeepaliveTimer = null;
  }

  async function pushPlaybackStatus(force = false) {
    if (!isAutoLearning || !isVideoPage()) return null;
    const state = await videoState();
    if (!state?.isVideoPage) return null;
    if (!force && !state.video) return state;
    const duration = state.video?.duration || 0;
    const currentTime = state.video?.currentTime || 0;
    inspectPlaybackHealth(state);
    safeSend({
      type: 'PLAYBACK_STATUS',
      courseId: state.courseId,
      courseTitle: state.courseName,
      sectionTitle: state.currentSectionTitle || '播放中',
      sectionIndex: state.currentSectionIndex || 0,
      totalSections: state.totalSections || 0,
      currentTime,
      duration,
      videoProgress: duration > 0 ? (currentTime / duration) * 100 : 0,
      lessonLocation: state.lessonLocation || 0,
      sessionTime: state.component?.sessionTime || 0,
      learningProgress: state.learningProgress || 0
    });
    return state;
  }

  function startPlaybackStatus() {
    if (playbackStatusTimer) return;
    playbackStatusTimer = setInterval(() => {
      if (!isAutoLearning || !isVideoPage()) return;
      pushPlaybackStatus();
    }, 1000);
  }

  function stopPlaybackStatus() {
    if (!playbackStatusTimer) return;
    clearInterval(playbackStatusTimer);
    playbackStatusTimer = null;
  }

  function resetPlaybackHealth() {
    playbackHealth = { lastTime: 0, lastAdvanceAt: 0, nudging: false, lastNudgeAt: 0 };
  }

  async function nudgePlayback(reason = 'stalled') {
    if (!isAutoLearning || !isVideoPage() || playbackHealth.nudging) return false;
    const now = Date.now();
    if (now - playbackHealth.lastNudgeAt < 4000) return false;
    playbackHealth.nudging = true;
    playbackHealth.lastNudgeAt = now;
    try {
      await bridge('ensurePlaybackActive', { reason, timeout: 8000, probeMs: 2200, minAdvance: 0.5 }, 18000);
      playbackHealth.lastAdvanceAt = Date.now();
      const current = getVideo();
      playbackHealth.lastTime = Number(current?.currentTime || playbackHealth.lastTime || 0);
      await pushPlaybackStatus(true);
      return true;
    } catch (_) {
      return false;
    } finally {
      playbackHealth.nudging = false;
    }
  }

  function inspectPlaybackHealth(state = null) {
    const v = getVideo();
    if (!v || !isAutoLearning || !isVideoPage()) return;
    const now = Date.now();
    const duration = Number(state?.video?.duration ?? v.duration ?? 0);
    const currentTime = Number(state?.video?.currentTime ?? v.currentTime ?? 0);
    if (!duration || v.ended) {
      playbackHealth.lastTime = currentTime;
      playbackHealth.lastAdvanceAt = now;
      return;
    }
    if (!playbackHealth.lastAdvanceAt) playbackHealth.lastAdvanceAt = now;
    if (currentTime > playbackHealth.lastTime + 0.2) {
      playbackHealth.lastTime = currentTime;
      playbackHealth.lastAdvanceAt = now;
      return;
    }
    const readyState = Number(state?.video?.readyState ?? v.readyState ?? 0);
    if (readyState >= 2 && now - playbackHealth.lastAdvanceAt > 6500) {
      nudgePlayback(v.paused ? 'paused' : 'stalled');
    }
  }

  function stopFlash() {
    if (!flashTimer) return;
    clearInterval(flashTimer);
    flashTimer = null;
    document.title = originalTitle || document.title;
    document.getElementById('hbgbzx-pause-alert')?.remove();
  }

  function startFlash() {
    if (flashTimer) return;
    originalTitle = originalTitle || document.title;
    let on = false;
    flashTimer = setInterval(() => {
      on = !on;
      document.title = on ? '⚠️ 视频暂停，请继续学习' : originalTitle;
    }, 800);
    const overlay = document.createElement('div');
    overlay.id = 'hbgbzx-pause-alert';
    overlay.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483647;display:flex;align-items:center;justify-content:center;"><div style="background:#fff;border-radius:12px;padding:28px 40px;text-align:center;box-shadow:0 10px 28px rgba(0,0,0,.28)"><div style="font-size:38px;margin-bottom:12px">⚠️</div><div style="font-size:18px;font-weight:700;color:#e74c3c;margin-bottom:10px">视频暂停超时</div><div style="font-size:14px;color:#333;margin-bottom:18px">请继续播放，避免学习中断。</div><button id="hbgbzx-alert-btn" style="padding:10px 26px;border:none;border-radius:6px;background:#409eff;color:#fff;cursor:pointer">知道了</button></div></div>';
    document.body.appendChild(overlay);
    document.getElementById('hbgbzx-alert-btn')?.addEventListener('click', () => stopFlash(), { once: true });
    safeSend({ type: 'VIDEO_PAUSED_ALERT' });
  }

  function startPauseTimer() {
    if (!settings.enableAlert || !isAutoLearning || !isVideoPage()) return;
    clearPauseState();
    pauseTimer = setTimeout(() => startFlash(), settings.alertTimeout * 60 * 1000);
  }

  function yearFilter() {
    const value = document.querySelector('input[readonly]')?.value?.trim() || '';
    return /^\d{4}$/.test(value) ? value : String(new Date().getFullYear());
  }

  async function uncompleted(page = 1, pageSize = 10) {
    return bridge('fetchUncompleted', { currentPage: page, pageSize, year: yearFilter() }, 5000);
  }

  async function courseDetail(courseId) {
    return bridge('fetchCourseDetail', { courseId }, 5000);
  }

  async function subjectGroups() {
    return bridge('fetchSubjectGroups', {}, 5000);
  }

  async function subjectCourses(subjectId, page = 1, pageSize = 20, year = '') {
    return bridge('fetchSubjectCourses', { subjectId, currentPage: page, pageSize, year }, 5000);
  }

  async function selectCourse(courseId) {
    return bridge('selectCourse', { courseId }, 5000);
  }

  async function openCourseDirect(courseId, typeInfo = 2, sameTab = false) {
    return bridge('openCourse', { courseId, typeInfo, sameTab }, 5000);
  }

  async function prepareCourseUrl(courseId, typeInfo = 2) {
    return bridge('prepareCourseUrl', { courseId, typeInfo }, 5000);
  }

  async function openCourseByVm(courseId, courseTitle = '', pageIndex = -1, typeInfo = 2) {
    return bridge('openCourseByVm', { courseId, courseTitle, pageIndex, typeInfo }, 5000);
  }

  async function getUserHours() {
    return bridge('getUserHours', {}, 5000);
  }

  function domCourseItems() {
    return Array.from(document.querySelectorAll('li.course_list')).map((item, index) => {
      const title = item.querySelector('.course_list_right_title')?.textContent?.trim() || '';
      const progressText = item.querySelector('.el-progress__text')?.textContent?.trim() || '0%';
      const progress = Number.parseInt(progressText, 10) || 0;
      const button = item.querySelector('.Save') || Array.from(item.querySelectorAll('div,button,a,span')).find(el => /开始学习|继续学习|我要选课/.test(el.textContent || ''));
      return { item, index, title, progress, button };
    }).filter(entry => entry.title && entry.button);
  }

  async function waitCourseDom(timeout = 12000) {
    const start = Date.now();
    while (Date.now() - start <= timeout) {
      const items = domCourseItems();
      if (items.length) return items;
      await delay(400);
    }
    return [];
  }

  async function scrapeCourses() {
    const [api, dom] = await Promise.allSettled([uncompleted(1, 10), waitCourseDom()]);
    const apiData = api.status === 'fulfilled' ? api.value : null;
    const domItems = dom.status === 'fulfilled' ? dom.value : [];
    const used = new Set();
    const courses = [];

    if (apiData?.data?.courses?.length && domItems.length) {
      for (const course of apiData.data.courses) {
        let hitIndex = domItems.findIndex((entry, idx) => !used.has(idx) && entry.title === course.course_name);
        if (hitIndex < 0) hitIndex = domItems.findIndex((entry, idx) => !used.has(idx));
        if (hitIndex < 0) continue;
        used.add(hitIndex);
        const hit = domItems[hitIndex];
        if (course.play_type !== 4) continue;
        courses.push({
          id: course.id,
          title: course.course_name,
          progress: Number(course.learning_progress) || hit.progress || 0,
          learningHour: Number(course.learning_hour) || 0,
          playType: course.play_type,
          pageIndex: hit.index
        });
      }
    }

    if (!courses.length && domItems.length) {
      domItems.forEach(entry => {
        courses.push({
          id: null,
          title: entry.title,
          progress: entry.progress,
          learningHour: 0,
          playType: 4,
          pageIndex: entry.index
        });
      });
    }

    return {
      courses,
      totalCount: apiData?.data?.pager?.rowCount || courses.length,
      totalHours: Number(apiData?.data?.totalHours) || 0
    };
  }

  async function clickCourseById(courseId, fallbackTitle = '', fallbackPageIndex = -1, sameTab = false) {
    const snapshot = await scrapeCourses();
    let target = snapshot.courses.find(item => item.id && item.id === courseId);
    if (!target && fallbackTitle) target = snapshot.courses.find(item => item.title === fallbackTitle);
    if (!target && fallbackPageIndex >= 0) target = snapshot.courses.find(item => item.pageIndex === fallbackPageIndex);
    if (!target) target = snapshot.courses[0];
    if (!target) return { clicked: false, error: '未找到可学习课程' };
    if (sameTab) {
      try {
        return await bridge('openCourseByClick', { courseTitle: target.title, pageIndex: target.pageIndex, sameTab: true }, 8000);
      } catch (error) {
        return { clicked: false, error: error?.message || '同标签点击失败' };
      }
    }
    const items = await waitCourseDom();
    const entry = items.find(item => item.index === target.pageIndex) || items[0];
    const button = entry?.button;
    if (!button) return { clicked: false, error: '未找到开始学习按钮' };
    button.scrollIntoView({ block: 'center' });
    await delay(240);
    button.click();
    return { clicked: true, courseId: target.id, title: target.title, pageIndex: target.pageIndex };
  }

  async function syncSection(force = false) {
    if (!isVideoPage()) return null;
    const state = await videoState();
    if (!state?.isVideoPage) return null;
    const key = `${state.courseId}:${state.currentSectionIndex}:${state.totalSections}:${state.video?.src || ''}`;
    if (!force && key === sectionState.key) return state;
    sectionState.key = key;
    resetPlaybackHealth();
    safeSend({
      type: 'SECTION_CHANGED',
      courseId: state.courseId,
      sectionTitle: state.currentSectionTitle || '播放中',
      sectionIndex: state.currentSectionIndex || 0,
      totalSections: state.totalSections || 0
    });
    pushPlaybackStatus(true);
    return state;
  }

  function dismissDialogs() {
    const boxes = document.querySelectorAll('.el-dialog__wrapper,.el-message-box__wrapper');
    boxes.forEach(box => {
      if (box.style.display === 'none') return;
      const text = box.textContent || '';
      if (!/已打开多门课程|停止计时|关闭当前课程|提示|确定/.test(text)) return;
      const btn = box.querySelector('.el-button--primary,.el-message-box__btns button,.el-dialog__headerbtn,button');
      if (btn && btn.dataset.autoClicked !== '1') {
        btn.dataset.autoClicked = '1';
        setTimeout(() => { btn.click(); delete btn.dataset.autoClicked; }, 180);
      }
    });
  }

  function stopDialogWatch() {
    if (dialogObserver) dialogObserver.disconnect();
    dialogObserver = null;
  }

  function watchDialogs() {
    if (dialogObserver || !document.body) return;
    dialogObserver = new MutationObserver(() => dismissDialogs());
    dialogObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    dismissDialogs();
  }

  async function finalizeCourse(candidate) {
    if (sectionState.completionSent) return;
    sectionState.completionSent = true;
    try { await bridge('commitProgress', {}, 2500); } catch (_) {}
    await delay(1800);
    await pushPlaybackStatus(true);
    safeSend({
      type: 'ALL_SECTIONS_COMPLETE',
      courseId: candidate.courseId,
      courseTitle: candidate.courseName,
      finalCurrentTime: candidate.video?.currentTime || 0,
      finalDuration: candidate.video?.duration || 0,
      finalLessonLocation: candidate.lessonLocation || 0,
      finalSessionTime: candidate.component?.sessionTime || 0,
      finalSectionIndex: candidate.currentSectionIndex || 0,
      finalTotalSections: candidate.totalSections || 0
    });
  }

  async function fallbackNext(state) {
    const nextIndex = (state.currentSectionIndex || 0) + 1;
    try {
      await bridge('switchChapter', { index: nextIndex }, 5000);
    } catch (_) {
      const items = Array.from(document.querySelectorAll('.menu_item'));
      const next = items[nextIndex];
      if (!next) return finalizeCourse(state);
      next.scrollIntoView({ block: 'center' });
      await delay(220);
      next.click();
    }
    await delay(1500);
    await syncSection(true);
    await applyPlaybackRate(true);
    await resumeVideo();
  }

  async function handleEnded(token, target) {
    if (!isAutoLearning || token !== learningToken || !isVideoPage()) return;
    clearPauseState();
    const before = await videoState();
    await delay(2000);
    if (!isAutoLearning || token !== learningToken || !isVideoPage()) return;
    const after = await videoState();
    const advanced = before && after && before.courseId === after.courseId && after.currentSectionIndex > before.currentSectionIndex;
    const srcChanged = before?.video?.src && after?.video?.src && before.video.src !== after.video.src;
    if (advanced || srcChanged) {
      await syncSection(true);
      await applyPlaybackRate(true);
      await resumeVideo();
      return;
    }
    if (before && before.totalSections > 0 && before.currentSectionIndex >= before.totalSections - 1) {
      await finalizeCourse(before);
      return;
    }
    if (before) await fallbackNext(before);
  }

  function mediaEvent(event) {
    if (!(event.target instanceof HTMLVideoElement) || !isVideoPage()) return;
    if (event.type === 'play' || event.type === 'playing') {
      stopFlash();
      clearPauseState();
      syncSection();
      applyPlaybackRate();
      pushPlaybackStatus(true);
      return;
    }
    if (event.type === 'loadeddata' || event.type === 'seeked' || event.type === 'ratechange') {
      applyPlaybackRate(true);
      syncSection();
      pushPlaybackStatus(true);
      return;
    }
    if (event.type === 'pause') {
      pushPlaybackStatus(true);
      if (!isAutoLearning || event.target.ended) return;
      startPauseTimer();
      resumeTimer = setTimeout(() => { if (isAutoLearning) resumeVideo(event.target); }, 2200);
      return;
    }
    if (event.type === 'ended') handleEnded(learningToken, event.target);
  }

  function bindMedia() {
    ['play', 'playing', 'loadeddata', 'seeked', 'ratechange', 'pause', 'ended'].forEach(type => {
      document.addEventListener(type, mediaEvent, true);
    });
  }

  async function startLearning() {
    if (!isVideoPage()) return false;
    learningToken += 1;
    isAutoLearning = true;
    sectionState = { key: '', completionSent: false };
    resetPlaybackHealth();
    watchDialogs();
    startRateKeepalive();
    startPlaybackStatus();
    await syncSection(true);
    await applyPlaybackRate(true);
    await nudgePlayback('startup');
    await pushPlaybackStatus(true);
    return true;
  }

  function stopLearning() {
    learningToken += 1;
    isAutoLearning = false;
    clearPauseState();
    stopRateKeepalive();
    stopPlaybackStatus();
    resetPlaybackHealth();
    stopFlash();
    stopDialogWatch();
    sectionState = { key: '', completionSent: false };
  }

  function safeSend(msg, cb) {
    try {
      const p = chrome.runtime?.sendMessage(msg, cb);
      if (p && typeof p.catch === 'function') p.catch(err => {
        if (err?.message?.includes('Extension context invalidated')) stopLearning();
      });
    } catch (err) {
      if (err?.message?.includes('Extension context invalidated')) stopLearning();
    }
  }

  chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    (async () => {
      switch (message.type) {
        case 'SCRAPE_COURSES': sendResponse(await scrapeCourses()); break;
        case 'CLICK_COURSE': sendResponse(await clickCourseById(message.courseId, message.courseTitle, message.pageIndex, !!message.sameTab)); break;
        case 'GET_UNCOMPLETED': sendResponse(await uncompleted(message.page || 1, message.pageSize || 10)); break;
        case 'FETCH_COURSE_DETAIL': sendResponse(await courseDetail(message.courseId)); break;
        case 'GET_SUBJECT_GROUPS': sendResponse(await subjectGroups()); break;
        case 'GET_SUBJECT_COURSES': sendResponse(await subjectCourses(message.subjectId, message.page || 1, message.pageSize || 20, message.year || '')); break;
        case 'SELECT_COURSE': sendResponse(await selectCourse(message.courseId)); break;
        case 'OPEN_COURSE_BY_VM': sendResponse(await openCourseByVm(message.courseId, message.courseTitle, message.pageIndex, message.typeInfo || 2)); break;
        case 'OPEN_COURSE_DIRECT': sendResponse(await openCourseDirect(message.courseId, message.typeInfo || 2, !!message.sameTab)); break;
        case 'PREPARE_COURSE_URL': { let r = null; try { r = await prepareCourseUrl(message.courseId, message.typeInfo || 2); } catch (_) {} sendResponse(r); break; }
        case 'GET_USER_HOURS': sendResponse(await getUserHours()); break;
        case 'START_VIDEO_LEARNING':
          settings.speedRate = clampRate(message.speedRate ?? settings.speedRate);
          settings.enableAlert = message.enableAlert !== false;
          settings.alertTimeout = Number(message.alertTimeout) > 0 ? Number(message.alertTimeout) : settings.alertTimeout;
          sendResponse({ ok: await startLearning() });
          break;
        case 'STOP_LEARNING': stopLearning(); sendResponse({ ok: true }); break;
        case 'WAIT_FOR_VIDEO': {
          const start = Date.now();
          while (Date.now() - start <= (message.timeout || 30000)) {
            if (getVideo()) return sendResponse({ found: true, elapsed: Date.now() - start });
            await delay(500);
          }
          sendResponse({ found: false, elapsed: Date.now() - start, hash: location.hash });
          break;
        }
        case 'CHECK_PAGE': {
          const state = await videoState();
          sendResponse({
            url: location.href,
            hash: location.hash,
            isCourseList: location.hash.includes('my_course'),
            isSelectionPage: location.hash.includes('curricula_variable'),
            isVideoPage: !!state?.isVideoPage,
            hasVideo: !!getVideo(),
            sectionCount: state?.totalSections || 0,
            courseCount: document.querySelectorAll('li.course_list').length,
            title: document.title,
            courseId: state?.courseId || null,
            currentSectionIndex: state?.currentSectionIndex || 0
          });
          break;
        }
        case 'UPDATE_SETTINGS':
          settings.speedRate = clampRate(message.speedRate ?? settings.speedRate);
          settings.enableAlert = message.enableAlert ?? settings.enableAlert;
          settings.alertTimeout = Number(message.alertTimeout) > 0 ? Number(message.alertTimeout) : settings.alertTimeout;
          await applyPlaybackRate(true);
          sendResponse({ ok: true });
          break;
        default: sendResponse({ error: 'unknown' });
      }
    })();
    return true;
  });

  function onReady() {
    originalTitle = document.title;
    loadSettings();
    chrome.storage.local.get({ autoLearnState: null }, saved => syncRestOverlay(saved.autoLearnState));
    bindMedia();
    if (isVideoPage()) {
      watchDialogs();
      syncSection(true);
      applyPlaybackRate(true);
    }
    window.addEventListener('hashchange', () => {
      stopFlash();
      clearPauseState();
      sectionState = { key: '', completionSent: false };
      resetPlaybackHealth();
      if (isVideoPage()) {
        watchDialogs();
        if (isAutoLearning) {
          startRateKeepalive();
          startPlaybackStatus();
          nudgePlayback('hashchange');
        }
        syncSection(true);
        applyPlaybackRate(true);
        pushPlaybackStatus(true);
      } else {
        stopRateKeepalive();
        stopPlaybackStatus();
        stopDialogWatch();
      }
    });
  }

  injectBridge();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  else onReady();
})();
