(() => {
  'use strict';

  const REQ = 'HBGBZX_PAGE_REQUEST';
  const RES = 'HBGBZX_PAGE_RESPONSE';

  const ok = data => ({ ok: true, data });
  const fail = message => ({ ok: false, message });

  const define = (target, key, getter) => {
    try { Object.defineProperty(target, key, { configurable: true, get: getter }); } catch (_) {}
  };

  const applyVisibilityPatch = () => {
    define(document, 'hidden', () => false);
    define(document, 'visibilityState', () => 'visible');
    define(document, 'webkitVisibilityState', () => 'visible');
    document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
  };

  const rootVm = () => document.querySelector('#app')?.__vue__ || null;
  const walkVm = (matcher) => {
    const root = rootVm();
    if (!root) return null;
    const queue = [root];
    while (queue.length) {
      const vm = queue.shift();
      try {
        if (matcher(vm)) return vm;
        (vm.$children || []).forEach(child => queue.push(child));
      } catch (_) {}
    }
    return null;
  };

  const videoVm = () => walkVm(vm => vm?.$options?.name === 'video_detail');
  const studyCourseVm = () => walkVm(vm => vm?.$options?.name === 'study_course');
  const playerComp = () => videoVm()?.$refs?.player || null;
  const player = () => playerComp()?.player || null;
  const video = () => player()?.V || document.querySelector('video') || null;

  const toNum = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };

  const normalizeRate = rate => {
    const value = toNum(rate, 1.5);
    return Math.max(1, Math.min(1.5, value));
  };

  const formatRate = rate => `${normalizeRate(rate).toFixed(1)}X`;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const fetchJson = async (url, init = {}) => {
    const resp = await fetch(url, { credentials: 'include', ...init });
    return resp.json();
  };

  const formBody = payload => {
    const params = new URLSearchParams();
    Object.entries(payload || {}).forEach(([key, value]) => {
      params.append(key, value == null ? '' : String(value));
    });
    return params.toString();
  };

  const flattenSections = vm => {
    const list = Array.isArray(vm?.course_menu) ? vm.course_menu : [];
    return list.map((item, index) => ({
      index,
      sco_id: item?.sco_id || '',
      identifierref: item?.identifierref || '',
      text: item?.sco_name || `章节${index + 1}`
    }));
  };

  const currentSectionIndex = (vm, sections) => {
    const index = toNum(vm?.$store?.state?.playIndex, -1);
    if (index >= 0 && index < sections.length) return index;
    const activeId = vm?.$store?.state?.playObj?.sco_id || '';
    const activeIndex = sections.findIndex(item => item.sco_id === activeId);
    return activeIndex >= 0 ? activeIndex : (sections.length ? 0 : -1);
  };

  const getVideoState = () => {
    const vm = videoVm();
    const comp = playerComp();
    const p = player();
    const v = video();
    const sections = flattenSections(vm);
    const index = currentSectionIndex(vm, sections);
    return ok({
      isVideoPage: !!vm,
      courseId: vm?.$route?.query?.id || null,
      courseName: vm?.details_list?.course_name || '',
      playCourse: vm?.playCourse || sessionStorage.getItem('playCourse') || '',
      userCourseId: toNum(vm?.user_course_id, 0),
      totalSections: sections.length,
      currentSectionIndex: index,
      currentSectionTitle: sections[index]?.text || '',
      sections,
      lessonLocation: toNum(vm?.$store?.state?.playObj?.lesson_location, 0),
      learningProgress: toNum(vm?.details_list?.learning_progress, 0),
      isCompleted: toNum(vm?.details_list?.is_completed, 0) === 1,
      player: p ? {
        supportedRates: Array.isArray(p.playbackRateArr) ? p.playbackRateArr.map(item => toNum(item?.[0], 1)) : [],
        playbackRateTemp: toNum(p.playbackRateTemp, 1),
        playbackRateDefault: toNum(p.playbackRateDefault, 0),
        uiLabel: p.CB?.playbackrate?.innerText || ''
      } : null,
      component: comp ? {
        sessionTime: toNum(comp.v_session_time ?? comp.session_time, 0),
        defaultBackrate: toNum(comp.default_backrate, 0)
      } : null,
      video: v ? {
        src: v.currentSrc || v.src || '',
        paused: !!v.paused,
        ended: !!v.ended,
        readyState: toNum(v.readyState, 0),
        currentTime: toNum(v.currentTime, 0),
        duration: toNum(v.duration, 0),
        playbackRate: toNum(v.playbackRate, 1)
      } : null
    });
  };

  const setPlaybackRate = rate => {
    const comp = playerComp();
    const p = player();
    const v = video();
    if (!v) return fail('no-video');
    const target = normalizeRate(rate);
    const rates = Array.isArray(p?.playbackRateArr) ? p.playbackRateArr : [];
    const index = rates.findIndex(item => Math.abs(toNum(item?.[0], 0) - target) < 0.01);
    if (p && index >= 0 && typeof p.changePlaybackRate === 'function') {
      p.changePlaybackRate(index);
      p.playbackRateTemp = target;
      p.playbackRateDefault = index;
      if (comp) comp.default_backrate = index;
      if (p.CB?.playbackrate) p.CB.playbackrate.textContent = formatRate(target);
    } else {
      v.playbackRate = target;
      if (p?.CB?.playbackrate) p.CB.playbackrate.textContent = formatRate(target);
    }
    return getVideoState();
  };

  const resumePlayback = async () => {
    const p = player();
    const comp = playerComp();
    const v = video();
    if (!v) return fail('no-video');
    if (v.ended) return fail('video-ended');
    v.autoplay = true;
    v.playsInline = true;
    const tryPlay = async () => {
      if (typeof comp?.bindPlay === 'function') {
        const result = comp.bindPlay();
        if (result && typeof result.then === 'function') await result;
        return;
      }
      if (typeof p?.videoPlay === 'function') {
        const result = p.videoPlay();
        if (result && typeof result.then === 'function') await result;
        return;
      }
      const result = v.play();
      if (result && typeof result.then === 'function') await result;
    };
    try {
      await tryPlay();
    } catch (error) {
      try {
        v.muted = true;
        await tryPlay();
      } catch (mutedError) {
        return fail(mutedError?.message || error?.message || 'resume-failed');
      }
    }
    return getVideoState();
  };

  const waitUntilVideoReady = async (timeout = 15000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeout) {
      const state = getVideoState();
      const v = state?.data?.video;
      if (v && v.duration > 0 && v.readyState >= 2) return state;
      await sleep(300);
    }
    return fail('video-not-ready');
  };

  const playbackAdvanced = async (waitMs = 2400, minAdvance = 0.6) => {
    const before = getVideoState();
    const start = before?.data?.video?.currentTime || 0;
    await sleep(waitMs);
    const after = getVideoState();
    const end = after?.data?.video?.currentTime || 0;
    return {
      before,
      after,
      advanced: end >= start + minAdvance,
      delta: end - start
    };
  };

  const clickPlaybackControl = () => {
    const scored = Array.from(document.querySelectorAll('[class], video, .video_center')).map(el => {
      if (!(el instanceof HTMLElement)) return null;
      const cls = typeof el.className === 'string' ? el.className : '';
      let score = -1;
      if (/playch/i.test(cls) && !/canvas/i.test(cls)) score = 100;
      else if (/pausecenter/i.test(cls) && !/canvas/i.test(cls)) score = 80;
      else if (/video_center/i.test(cls)) score = 40;
      else if (el.tagName === 'VIDEO') score = 20;
      else if (/ckplayer/i.test(cls)) score = 10;
      if (score < 0) return null;
      return { el, score, cls };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    for (const item of scored) {
      const rect = item.el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      try {
        item.el.click();
        return ok({ clicked: true, className: item.cls || item.el.tagName });
      } catch (_) {}
    }
    return fail('no-play-control');
  };

  const ensurePlaybackActive = async payload => {
    const ready = await waitUntilVideoReady(payload?.timeout || 15000);
    if (!ready?.ok) return ready;
    const firstProbe = await playbackAdvanced(payload?.probeMs || 2400, payload?.minAdvance || 0.6);
    if (firstProbe.advanced) return firstProbe.after;
    const attempts = [
      async () => { await resumePlayback(); },
      async () => {
        const v = video();
        if (!v || v.ended) return;
        try { v.pause(); } catch (_) {}
        await sleep(120);
        await resumePlayback();
      },
      async () => {
        clickPlaybackControl();
      },
      async () => {
        const v = video();
        if (!v || v.ended) return;
        v.muted = true;
        const result = v.play();
        if (result && typeof result.then === 'function') await result;
      }
    ];
    for (const attempt of attempts) {
      try { await attempt(); } catch (_) {}
      const probe = await playbackAdvanced(payload?.probeMs || 2400, payload?.minAdvance || 0.6);
      if (probe.advanced) return probe.after;
    }
    return fail('playback-stalled');
  };

  const switchChapter = async payload => {
    const vm = videoVm();
    if (!vm) return fail('no-vm');
    const sections = flattenSections(vm);
    const current = currentSectionIndex(vm, sections);
    const targetIndex = Math.max(0, Math.min(sections.length - 1, Number(payload?.index ?? current + 1)));
    if (!sections.length || targetIndex === current || !sections[targetIndex]) return fail('invalid-target');
    const target = Array.isArray(vm.course_menu) ? vm.course_menu[targetIndex] : null;
    const attempts = [
      () => typeof vm.switchChapter === 'function' && vm.switchChapter(target, targetIndex),
      () => typeof vm.switchChapter === 'function' && vm.switchChapter(targetIndex, target),
      () => typeof vm.video_change === 'function' && vm.video_change(target, targetIndex),
      () => typeof vm.video_change === 'function' && vm.video_change(targetIndex, target),
      () => {
        const items = Array.from(document.querySelectorAll('.menu_item'));
        items[targetIndex]?.click();
        return true;
      }
    ];
    for (const attempt of attempts) {
      try {
        const result = attempt();
        if (result && typeof result.then === 'function') await result;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 1200));
      const after = getVideoState();
      if (after?.data?.currentSectionIndex === targetIndex) return after;
    }
    return fail('switch-chapter-failed', { current, targetIndex });
  };

  const commitProgress = () => {
    const vm = videoVm();
    if (!vm || typeof vm.data_commit !== 'function') return fail('no-vm');
    vm.data_commit();
    return ok(true);
  };

  const fetchUncompleted = async payload => ok(await fetchJson('/trainee/api/course/uncompleted', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody(payload)
  }));

  const fetchCourseDetail = async courseId => ok(await fetchJson(`/trainee/api/course/detail/${courseId}`));
  const fetchSubjectGroups = async () => ok(await fetchJson('/trainee/api/subject/list'));
  const fetchSubjectCourses = async (subjectId, payload) => ok(await fetchJson(`/trainee/api/course/subject_course/${subjectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody(payload)
  }));
  const selectCourse = async courseId => ok(await fetchJson(`/trainee/api/course/elective/${courseId}`));
  const collectCourseButtons = () => Array.from(document.querySelectorAll('li.course_list')).map((item, index) => ({
    index,
    title: item.querySelector('.course_list_right_title')?.textContent?.trim() || '',
    button: item.querySelector('.Save') || Array.from(item.querySelectorAll('div,button,a,span')).find(el => /开始学习|继续学习|我要选课/.test(el.textContent || '')) || null
  })).filter(entry => entry.title && entry.button);
  const patchWindowOpenToSameTab = (timeout = 12000) => {
    const originalOpen = window.open;
    const patchedOpen = function(url) {
      if (typeof url === 'string' && url) location.assign(url);
      return window;
    };
    window.open = patchedOpen;
    setTimeout(() => {
      if (window.open === patchedOpen) window.open = originalOpen;
    }, timeout);
  };
  const openCourseByClick = async ({ courseTitle = '', pageIndex = -1, sameTab = false }) => {
    const items = collectCourseButtons();
    let target = courseTitle ? items.find(item => item.title === courseTitle) : null;
    if (!target && pageIndex >= 0) target = items.find(item => item.index === pageIndex);
    if (!target) target = items[0];
    if (!target?.button) return fail('no-course-button');
    target.button.scrollIntoView({ block: 'center' });
    if (sameTab) patchWindowOpenToSameTab();
    target.button.click();
    return ok({ clicked: true, title: target.title, pageIndex: target.index, sameTab });
  };
  const openCourseByVm = async ({ courseId, courseTitle = '', pageIndex = -1 }) => {
    const vm = studyCourseVm();
    const list = vm?.dataList?.courses || [];
    let course = list.find(item => Number(item?.id) === Number(courseId));
    if (!course && courseTitle) course = list.find(item => item?.course_name === courseTitle);
    if (!course && pageIndex >= 0) course = list[pageIndex] || null;
    if (!course || typeof vm?.to_course_play !== 'function') return fail('no-study-course-vm');
    const apiMap = { open_course: '/api/course/play', get_course_detail: '/api/course/detail' };
    await vm.to_course_play(course, apiMap);
    return ok({ code: 0, courseId: course.id, courseTitle: course.course_name });
  };
  const fetchLoginStatus = async () => ok(await fetchJson('/trainee/login/status?userInfo=', { method: 'POST' }));
  const getUserHours = async () => {
    const login = await fetchLoginStatus();
    const store = rootVm()?.$store?.state || {};
    const total = toNum(
      login?.data?.data?.total_learning_hours ??
      login?.data?.total_learning_hours ??
      store?.user_info?.total_learning_hours ??
      store?.total_learning_hours ??
      store?.userInfo?.total_learning_hours,
      0
    );
    return ok({ totalLearningHours: total, raw: login?.data || null });
  };
  const prepareCourseUrl = async (courseId, typeInfo = 2) => {
    const result = await fetchJson(`/trainee/api/course/play/${courseId}`);
    if (result?.code !== 0) return fail(result?.message || 'prepare-failed');
    const target = `${location.origin}/pc/index.html#/video_detail?id=${courseId}&typeInfo=${typeInfo}`;
    sessionStorage.setItem('playCourse', result?.data?.playCourse || '');
    return ok({ targetUrl: target, playCourse: result?.data?.playCourse || '' });
  };
  const openCourse = async (courseId, typeInfo = 2, sameTab = false) => {
    const result = await fetchJson(`/trainee/api/course/play/${courseId}`);
    if (result?.code !== 0) return fail(result?.message || 'open-course-failed');
    const target = `${location.origin}/pc/index.html#/video_detail?id=${courseId}&typeInfo=${typeInfo}`;
    sessionStorage.setItem('playCourse', result?.data?.playCourse || '');
    if (sameTab) location.assign(target);
    else window.open(target, '_blank');
    return ok(result);
  };

  applyVisibilityPatch();

  document.addEventListener(REQ, async event => {
    const detail = event.detail || {};
    if (!detail.id || !detail.action) return;
    let result;
    try {
      switch (detail.action) {
        case 'getVideoState': result = getVideoState(); break;
        case 'setPlaybackRate': result = setPlaybackRate(detail.payload?.rate); break;
        case 'resumePlayback': result = await resumePlayback(); break;
        case 'ensurePlaybackActive': result = await ensurePlaybackActive(detail.payload || {}); break;
        case 'switchChapter': result = await switchChapter(detail.payload); break;
        case 'commitProgress': result = commitProgress(); break;
        case 'fetchUncompleted': result = await fetchUncompleted(detail.payload); break;
        case 'fetchCourseDetail': result = await fetchCourseDetail(detail.payload?.courseId); break;
        case 'fetchSubjectGroups': result = await fetchSubjectGroups(); break;
        case 'fetchSubjectCourses': result = await fetchSubjectCourses(detail.payload?.subjectId, detail.payload); break;
        case 'selectCourse': result = await selectCourse(detail.payload?.courseId); break;
        case 'openCourseByClick': result = await openCourseByClick(detail.payload || {}); break;
        case 'openCourseByVm': result = await openCourseByVm(detail.payload || {}); break;
        case 'getUserHours': result = await getUserHours(); break;
        case 'openCourse': result = await openCourse(detail.payload?.courseId, detail.payload?.typeInfo, !!detail.payload?.sameTab); break;
        case 'prepareCourseUrl': result = await prepareCourseUrl(detail.payload?.courseId, detail.payload?.typeInfo || 2); break;
        default: result = fail(`unknown action: ${detail.action}`);
      }
    } catch (error) {
      result = fail(error?.message || String(error));
    }
    document.dispatchEvent(new CustomEvent(RES, { detail: { id: detail.id, result } }));
  });
})();
