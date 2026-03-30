const BASE_URL = 'http://www.hbgbzx.gov.cn/pc/index.html';
const MY_COURSE_HASH = '#/study_center/my_course';
const SELECT_HASH = '#/study_center/curricula_variable';
const DEFAULTS = { speedRate: 1.5, alertTimeout: 2, enableAlert: true, courseInterval: 2, targetHours: 50 };
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

let runGeneration = 0;
let spinnerTimer = null;
let spinnerIndex = 0;
let processedCourseIds = new Set();
let state = {
  status: 'IDLE',
  tabId: null,
  courseListTabId: null,
  videoTabId: null,
  currentCourseId: null,
  currentCourseTitle: '',
  currentSection: '',
  currentSectionIndex: 0,
  totalSections: 0,
  totalCourses: 0,
  completedCourses: 0,
  earnedHours: 0,
  currentPlaybackTime: 0,
  currentVideoDuration: 0,
  currentVideoProgress: 0,
  currentLessonLocation: 0,
  currentSessionTime: 0,
  currentCourseProgress: 0,
  lastProgressDelta: 0,
  lastHoursDelta: 0,
  lastResultNote: '',
  currentCourseBaseline: null,
  restUntil: 0,
  restMinutesLeft: 0,
  speedRate: DEFAULTS.speedRate,
  alertTimeout: DEFAULTS.alertTimeout,
  enableAlert: DEFAULTS.enableAlert,
  courseInterval: DEFAULTS.courseInterval,
  targetHours: DEFAULTS.targetHours,
  startTime: null,
  error: null
};

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sleepRand = (base, jitter) => sleep(base + rand(-jitter, jitter));
const cancelled = gen => gen !== runGeneration;
const clampRate = value => Math.max(1, Math.min(1.5, Number(value) || 1.5));
const shuffle = list => [...list].sort(() => Math.random() - 0.5);
const toNum = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};
const round2 = value => Math.round((Number(value) || 0) * 100) / 100;
const calcRestMinutes = ms => Math.max(0, Math.ceil(Math.max(0, ms) / 60000));
const calcRestLabel = ms => ms < 60000 ? '不足1分钟' : `${calcRestMinutes(ms)} 分钟`;

async function waitWithRestUpdates(gen, waitMs) {
  const startedAt = Date.now();
  const restUntil = startedAt + Math.max(0, waitMs);
  let shownMinutes = calcRestMinutes(waitMs);
  setState({
    status: 'RESTING',
    restUntil,
    restMinutesLeft: shownMinutes,
    lastResultNote: `休息中，约 ${calcRestLabel(waitMs)} 后继续学习`
  });
  while (!cancelled(gen)) {
    let remaining = restUntil - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(remaining, 5000));
    if (cancelled(gen)) return false;
    remaining = restUntil - Date.now();
    const nextMinutes = calcRestMinutes(remaining);
    if (nextMinutes !== shownMinutes) {
      shownMinutes = nextMinutes;
      setState({
        status: 'RESTING',
        restUntil,
        restMinutesLeft: nextMinutes,
        lastResultNote: `休息中，约 ${calcRestLabel(remaining)} 后继续学习`
      });
    }
  }
  if (cancelled(gen)) return false;
  setState({ status: 'SWITCHING', restUntil: 0, restMinutesLeft: 0 });
  return true;
}

function setState(patch = {}) {
  Object.assign(state, patch);
  chrome.storage.local.set({
    autoLearnState: {
      status: state.status,
      currentCourseTitle: state.currentCourseTitle,
      currentCourseIndex: state.completedCourses,
      totalCourses: state.totalCourses,
      completedCourses: state.completedCourses,
      earnedHours: state.earnedHours,
      currentSection: state.currentSection,
      currentSectionIndex: state.currentSectionIndex,
      totalSections: state.totalSections,
      currentPlaybackTime: state.currentPlaybackTime,
      currentVideoDuration: state.currentVideoDuration,
      currentVideoProgress: state.currentVideoProgress,
      currentLessonLocation: state.currentLessonLocation,
      currentSessionTime: state.currentSessionTime,
      currentCourseProgress: state.currentCourseProgress,
      lastProgressDelta: state.lastProgressDelta,
      lastHoursDelta: state.lastHoursDelta,
      lastResultNote: state.lastResultNote,
      restUntil: state.restUntil,
      restMinutesLeft: state.restMinutesLeft,
      speedRate: state.speedRate,
      targetHours: state.targetHours,
      error: state.error,
      startTime: state.startTime
    }
  });
}

function resetState() {
  state.currentCourseId = null;
  state.currentCourseTitle = '';
  state.currentSection = '';
  state.currentSectionIndex = 0;
  state.totalSections = 0;
  state.totalCourses = 0;
  state.completedCourses = 0;
  state.earnedHours = 0;
  state.currentPlaybackTime = 0;
  state.currentVideoDuration = 0;
  state.currentVideoProgress = 0;
  state.currentLessonLocation = 0;
  state.currentSessionTime = 0;
  state.currentCourseProgress = 0;
  state.lastProgressDelta = 0;
  state.lastHoursDelta = 0;
  state.lastResultNote = '';
  state.currentCourseBaseline = null;
  state.restUntil = 0;
  state.restMinutesLeft = 0;
  state.error = null;
  processedCourseIds = new Set();
}

function startSpinner() {
  if (spinnerTimer) return;
  chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  spinnerTimer = setInterval(() => {
    spinnerIndex = (spinnerIndex + 1) % SPINNER.length;
    chrome.action.setBadgeText({ text: SPINNER[spinnerIndex] });
  }, 150);
}

function stopSpinner() {
  if (spinnerTimer) clearInterval(spinnerTimer);
  spinnerTimer = null;
  chrome.action.setBadgeText({ text: '' });
}

async function loadSettings() {
  const saved = await chrome.storage.local.get(DEFAULTS);
  setState({
    speedRate: clampRate(saved.speedRate),
    alertTimeout: Number(saved.alertTimeout) > 0 ? Number(saved.alertTimeout) : DEFAULTS.alertTimeout,
    enableAlert: saved.enableAlert !== false,
    courseInterval: Number(saved.courseInterval) >= 0 ? Number(saved.courseInterval) : DEFAULTS.courseInterval,
    targetHours: Number(saved.targetHours) >= 1 ? Number(saved.targetHours) : DEFAULTS.targetHours
  });
}

async function getOrCreateTab() {
  if (state.tabId) {
    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (tab?.url?.includes('hbgbzx.gov.cn')) return tab;
    } catch (_) {}
  }
  const tabs = await chrome.tabs.query({ url: '*://www.hbgbzx.gov.cn/*' });
  if (tabs[0]) {
    state.tabId = tabs[0].id;
    return tabs[0];
  }
  const tab = await chrome.tabs.create({ url: BASE_URL + MY_COURSE_HASH });
  state.tabId = tab.id;
  return tab;
}

async function navigateTab(hash) {
  const tab = await getOrCreateTab();
  const targetUrl = BASE_URL + hash;
  const sameUrl = tab.url === targetUrl;
  if (sameUrl) await chrome.tabs.reload(tab.id, { bypassCache: true });
  else await chrome.tabs.update(tab.id, { url: targetUrl });
  state.tabId = tab.id;
  return new Promise(resolve => {
    const onUpdated = (tabId, info) => {
      if (tabId !== tab.id || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      setTimeout(resolve, 2200);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 15000);
  });
}

async function sendToContent(message, retry = true) {
  if (!state.tabId) return null;
  try {
    return await chrome.tabs.sendMessage(state.tabId, message);
  } catch (_) {
    if (!retry) return null;
    try {
      await chrome.tabs.reload(state.tabId, { bypassCache: true });
      await sleepRand(2200, 300);
      return await chrome.tabs.sendMessage(state.tabId, message);
    } catch (_) {
      return null;
    }
  }
}

async function ensureCoursePage(hash) {
  await navigateTab(hash);
  await sleepRand(1200, 300);
  await sendToContent({ type: 'CHECK_PAGE' }, false);
}

function waitForVideoTab(timeout = 15000) {
  return new Promise(resolve => {
    let done = false;
    const finish = tab => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(tab || null);
    };
    const onUpdated = (tabId, info, tab) => {
      if (info.status === 'complete' && tab?.url?.includes('video_detail')) finish(tab);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => finish(null), timeout);
  });
}

async function closeVideoTab() {
  if (state.videoTabId && state.videoTabId !== state.courseListTabId) {
    try { await chrome.tabs.remove(state.videoTabId); } catch (_) {}
  }
  state.videoTabId = null;
  if (state.courseListTabId) {
    state.tabId = state.courseListTabId;
  }
}

async function getUncompleted(pageSize = 10) {
  const resp = await sendToContent({ type: 'GET_UNCOMPLETED', page: 1, pageSize });
  return resp?.code === 0 ? resp.data : null;
}

async function getCourseDetail(courseId) {
  const resp = await sendToContent({ type: 'FETCH_COURSE_DETAIL', courseId });
  return resp?.code === 0 ? resp.data?.course || null : null;
}

function parseCourseMetrics(course, earnedHours = state.earnedHours) {
  let sco = {};
  try {
    sco = typeof course?.sco === 'string' ? JSON.parse(course.sco || '{}') : (course?.sco || {});
  } catch (_) {
    sco = {};
  }
  const scorm = Array.isArray(sco?.scormData) ? sco.scormData[0] || {} : {};
  return {
    learningProgress: round2(course?.learning_progress),
    isCompleted: Number(course?.is_completed) === 1,
    totalLearningHours: round2(earnedHours),
    userCourseId: toNum(course?.user_course_id ?? sco?.user_course_id, 0),
    playCourse: sco?.playCourse || '',
    lessonLocation: toNum(scorm?.lesson_location, 0),
    sessionTime: toNum(scorm?.session_time, 0)
  };
}

async function refreshEarnedHours() {
  const resp = await sendToContent({ type: 'GET_USER_HOURS' });
  const earnedHours = toNum(resp?.totalLearningHours ?? resp?.data?.totalLearningHours ?? state.earnedHours, 0);
  setState({ earnedHours });
  return earnedHours;
}

async function ensureSelectableCourses(gen) {
  let summary = await getUncompleted(10);
  if (cancelled(gen)) return null;
  if (summary?.courses?.length) return summary;
  const selected = await autoSelectCourses(gen);
  if (!selected || cancelled(gen)) return null;
  await ensureCoursePage(MY_COURSE_HASH);
  return getUncompleted(10);
}

function flattenSubjects(groups) {
  const list = [];
  (groups || []).forEach(group => {
    (group.category || []).forEach(main => {
      (main.categoryVos || []).forEach(subject => {
        list.push({ id: subject.id, name: subject.category_name, hours: Number(subject.course_learning_hour) || 0 });
      });
    });
  });
  return list;
}

async function autoSelectCourses(gen) {
  await ensureCoursePage(SELECT_HASH);
  if (cancelled(gen)) return false;
  const groupsResp = await sendToContent({ type: 'GET_SUBJECT_GROUPS' });
  const groups = groupsResp?.code === 0 ? groupsResp.data?.category_group || [] : [];
  const subjects = shuffle(flattenSubjects(groups));
  if (!subjects.length) return false;

  let summary = await getUncompleted(10);
  let totalHours = Number(summary?.totalHours) || 0;
  const selectedIds = new Set((summary?.courses || []).map(item => item.id));
  const needed = Math.max(1, state.targetHours - state.earnedHours);
  if (summary?.courses?.length && totalHours >= needed) return true;

  for (const subject of subjects) {
    if (cancelled(gen) || totalHours >= needed) break;
    let page = 1;
    let hasNext = true;
    while (hasNext && !cancelled(gen) && totalHours < needed) {
      const resp = await sendToContent({ type: 'GET_SUBJECT_COURSES', subjectId: subject.id, page, pageSize: 20, year: '' });
      const data = resp?.code === 0 ? resp.data : null;
      const courses = data?.courses || [];
      hasNext = !!data?.pager?.nextPageAvailable;
      if (!courses.length) break;
      const eligible = shuffle(courses.filter(course => course.play_type === 4 && course.learning_progress == null && Number(course.learning_hour) >= 1 && !selectedIds.has(course.id)));
      for (const course of eligible) {
        const selected = await sendToContent({ type: 'SELECT_COURSE', courseId: course.id });
        if (selected?.code === 0) {
          selectedIds.add(course.id);
          await sleepRand(500, 180);
          summary = await getUncompleted(10);
          totalHours = Number(summary?.totalHours) || totalHours;
          if (totalHours >= needed) return true;
        }
        if (cancelled(gen)) return false;
      }
      page += 1;
    }
  }

  summary = await getUncompleted(10);
  return !!summary?.courses?.length;
}

async function startCourseInVideo(gen, course) {
  state.courseListTabId = state.tabId;
  const beforeDetail = course?.id ? await getCourseDetail(course.id) : null;
  const baseline = parseCourseMetrics(beforeDetail, state.earnedHours);
  setState({
    status: 'SWITCHING',
    currentCourseId: course.id,
    currentCourseTitle: course.title,
    currentSection: '',
    currentSectionIndex: 0,
    totalSections: 0,
    currentPlaybackTime: 0,
    currentVideoDuration: 0,
    currentVideoProgress: 0,
    currentLessonLocation: baseline.lessonLocation,
    currentSessionTime: baseline.sessionTime,
    currentCourseProgress: baseline.learningProgress,
    lastProgressDelta: 0,
    lastHoursDelta: 0,
    lastResultNote: '',
    currentCourseBaseline: baseline,
    error: null
  });

  try { await sendToContent({ type: 'PREPARE_COURSE_URL', courseId: course.id, typeInfo: 2 }); } catch (_) {}

  const videoUrl = BASE_URL + `#/video_detail?id=${course.id}&typeInfo=2`;
  const watchTabId = state.tabId;
  await new Promise(resolve => {
    const onUpdated = (tabId, info) => {
      if (tabId !== watchTabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      setTimeout(resolve, 2200);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(watchTabId, { url: videoUrl }).catch(() => {});
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 15000);
  });

  state.videoTabId = state.tabId;
  if (cancelled(gen)) return false;
  const page = await sendToContent({ type: 'CHECK_PAGE' });
  if (!page?.isVideoPage) {
    await sleepRand(2500, 500);
    if (cancelled(gen)) return false;
  }
  const ready = await sendToContent({ type: 'WAIT_FOR_VIDEO', timeout: 30000 });
  if (!ready?.found) {
    await closeVideoTab();
    setState({ error: '视频加载超时，重试当前课程。' });
    return false;
  }

  setState({ status: 'LEARNING', error: null });
  await sendToContent({
    type: 'START_VIDEO_LEARNING',
    speedRate: state.speedRate,
    enableAlert: state.enableAlert,
    alertTimeout: state.alertTimeout
  });
  return true;
}

async function openNextCourse(gen) {
  if (cancelled(gen)) return false;
  await ensureCoursePage(MY_COURSE_HASH);
  if (cancelled(gen)) return false;
  await refreshEarnedHours();
  if (state.earnedHours >= state.targetHours) {
    stopSpinner();
    setState({ status: 'COMPLETED', lastResultNote: `已获得 ${state.earnedHours.toFixed(2)} 学时，达到目标 ${state.targetHours} 学时，停止学习。如需继续学习请修改目标学时。`, error: null });
    return false;
  }
  const summary = await ensureSelectableCourses(gen);
  if (cancelled(gen)) return false;
  if (!summary?.courses?.length) {
    stopSpinner();
    setState({ status: 'COMPLETED', lastResultNote: '所有课程已完成或无可选课程', error: null });
    return false;
  }
  const courseData = summary.courses.find(c => !processedCourseIds.has(c.id)) || summary.courses[0];
  const course = { id: courseData.id, title: courseData.course_name, pageIndex: 0 };
  const ok = await startCourseInVideo(gen, course);
  if (!ok && !cancelled(gen)) {
    await sleepRand(1200, 250);
    return openNextCourse(gen);
  }
  return ok;
}

async function reopenCourseDirect(courseId, title, gen) {
  if (cancelled(gen)) return false;
  await ensureCoursePage(MY_COURSE_HASH);
  if (cancelled(gen)) return false;
  const detail = await getCourseDetail(courseId);
  const ok = await startCourseInVideo(gen, {
    id: courseId,
    title: title || detail?.course_name || state.currentCourseTitle,
    pageIndex: 0
  });
  if (!ok && !cancelled(gen)) {
    await sleepRand(1200, 250);
    return reopenCourseDirect(courseId, title, gen);
  }
  return ok;
}

async function confirmCourseOutcome(courseId, gen) {
  const baseline = state.currentCourseBaseline || parseCourseMetrics(null, state.earnedHours);
  await ensureCoursePage(MY_COURSE_HASH);
  await refreshEarnedHours();
  let lastMetrics = baseline;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (cancelled(gen)) return { accepted: false, metrics: baseline, deltaProgress: 0, deltaHours: 0 };
    const detail = await getCourseDetail(courseId);
    const metrics = parseCourseMetrics(detail, state.earnedHours);
    const deltaProgress = round2(metrics.learningProgress - baseline.learningProgress);
    const deltaHours = round2(metrics.totalLearningHours - baseline.totalLearningHours);
    const deltaLesson = metrics.lessonLocation - baseline.lessonLocation;
    const deltaSession = metrics.sessionTime - baseline.sessionTime;
    lastMetrics = metrics;
    if (metrics.isCompleted || deltaProgress > 0 || deltaHours > 0 || deltaLesson > 0 || deltaSession > 0) {
      return {
        accepted: true,
        metrics,
        deltaProgress,
        deltaHours,
        isCompleted: metrics.isCompleted,
        deltaLesson,
        deltaSession
      };
    }
    await getUncompleted(20);
    await sleepRand(3000, 600);
    await refreshEarnedHours();
  }
  return {
    accepted: false,
    metrics: lastMetrics,
    deltaProgress: round2(lastMetrics.learningProgress - baseline.learningProgress),
    deltaHours: round2(lastMetrics.totalLearningHours - baseline.totalLearningHours),
    isCompleted: lastMetrics.isCompleted
  };
}

async function startAutoLearn() {
  runGeneration += 1;
  const gen = runGeneration;
  resetState();
  await loadSettings();
  setState({ status: 'SCRAPING', startTime: Date.now(), error: null });
  startSpinner();
  await openNextCourse(gen);
}

async function stopAutoLearn() {
  runGeneration += 1;
  await sendToContent({ type: 'STOP_LEARNING' });
  await closeVideoTab();
  stopSpinner();
  resetState();
  setState({ status: 'IDLE', startTime: null, error: null });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'START_AUTO_LEARN':
        startAutoLearn();
        sendResponse({ ok: true });
        break;
      case 'STOP_AUTO_LEARN':
        stopAutoLearn();
        sendResponse({ ok: true });
        break;
      case 'GET_STATE':
        if (state.tabId) {
          try { await refreshEarnedHours(); } catch (_) {}
        }
        sendResponse({
          status: state.status,
          currentCourseTitle: state.currentCourseTitle,
          currentCourseIndex: state.completedCourses,
          totalCourses: state.totalCourses,
          completedCourses: state.completedCourses,
          earnedHours: state.earnedHours,
          currentSection: state.currentSection,
          currentSectionIndex: state.currentSectionIndex,
          totalSections: state.totalSections,
          currentPlaybackTime: state.currentPlaybackTime,
          currentVideoDuration: state.currentVideoDuration,
          currentVideoProgress: state.currentVideoProgress,
          currentLessonLocation: state.currentLessonLocation,
          currentSessionTime: state.currentSessionTime,
          currentCourseProgress: state.currentCourseProgress,
          lastProgressDelta: state.lastProgressDelta,
          lastHoursDelta: state.lastHoursDelta,
          lastResultNote: state.lastResultNote,
          restUntil: state.restUntil,
          restMinutesLeft: state.restMinutesLeft,
          speedRate: state.speedRate,
          targetHours: state.targetHours,
          error: state.error,
          startTime: state.startTime
        });
        break;
      case 'SECTION_CHANGED':
        setState({
          currentSection: message.sectionTitle || '',
          currentSectionIndex: Number(message.sectionIndex) || 0,
          totalSections: Number(message.totalSections) || 0,
          error: null
        });
        sendResponse({ ok: true });
        break;
      case 'PLAYBACK_STATUS':
        setState({
          currentCourseId: message.courseId || state.currentCourseId,
          currentCourseTitle: message.courseTitle || state.currentCourseTitle,
          currentSection: message.sectionTitle || state.currentSection,
          currentSectionIndex: Number(message.sectionIndex) || 0,
          totalSections: Number(message.totalSections) || 0,
          currentPlaybackTime: toNum(message.currentTime, 0),
          currentVideoDuration: toNum(message.duration, 0),
          currentVideoProgress: toNum(message.videoProgress, 0),
          currentLessonLocation: toNum(message.lessonLocation, 0),
          currentSessionTime: toNum(message.sessionTime, 0),
          currentCourseProgress: toNum(message.learningProgress, state.currentCourseProgress),
          error: null
        });
        sendResponse({ ok: true });
        break;
      case 'ALL_SECTIONS_COMPLETE': {
        const gen = runGeneration;
        const courseId = message.courseId || state.currentCourseId;
        const courseTitle = message.courseTitle || state.currentCourseTitle;
        await closeVideoTab();
        const outcome = courseId ? await confirmCourseOutcome(courseId, gen) : { accepted: false, metrics: state.currentCourseBaseline || null, deltaProgress: 0, deltaHours: 0, isCompleted: false };
        if (cancelled(gen)) return;
        if (outcome.accepted) {
          if (courseId) processedCourseIds.add(courseId);
          setState({
            completedCourses: state.completedCourses + 1,
            currentSection: '',
            currentSectionIndex: 0,
            totalSections: 0,
            currentPlaybackTime: 0,
            currentVideoDuration: 0,
            currentVideoProgress: 0,
            currentLessonLocation: outcome.metrics?.lessonLocation || 0,
            currentSessionTime: outcome.metrics?.sessionTime || 0,
            currentCourseProgress: outcome.metrics?.learningProgress || 0,
            lastProgressDelta: outcome.deltaProgress || 0,
            lastHoursDelta: outcome.deltaHours || 0,
            lastResultNote: outcome.isCompleted ? '课程已完成' : `进度已增加 +${round2(outcome.deltaProgress || 0)}%`,
            status: 'SWITCHING',
            restUntil: 0,
            restMinutesLeft: 0,
            error: null
          });
          const waitMs = Math.max(0, state.courseInterval) * 60 * 1000;
          if (waitMs > 0) {
            const rested = await waitWithRestUpdates(gen, waitMs);
            if (!rested || cancelled(gen)) break;
          }
          if (!cancelled(gen)) await openNextCourse(gen);
        } else {
          setState({
            status: 'SWITCHING',
            lastResultNote: '课程结束后未检测到进度增加',
            error: '课程结束后未检测到观看进度增加，重试当前课程。'
          });
          await sleepRand(1200, 250);
          if (!cancelled(gen) && courseId) await reopenCourseDirect(courseId, courseTitle, gen);
        }
        sendResponse({ ok: true, accepted: outcome.accepted, completed: !!outcome.isCompleted });
        break;
      }
      case 'VIDEO_ERROR':
        setState({ error: message.error || '视频页异常' });
        sendResponse({ ok: true });
        break;
      case 'VIDEO_PAUSED_ALERT':
        if (sender.tab?.id) {
          try {
            const tab = await chrome.tabs.get(sender.tab.id);
            if (tab.windowId) await chrome.windows.update(tab.windowId, { drawAttention: true });
          } catch (_) {}
        }
        sendResponse({ ok: true });
        break;
      case 'UPDATE_SETTINGS':
        setState({
          speedRate: clampRate(message.speedRate ?? state.speedRate),
          alertTimeout: Number(message.alertTimeout) > 0 ? Number(message.alertTimeout) : state.alertTimeout,
          enableAlert: message.enableAlert ?? state.enableAlert,
          courseInterval: Number(message.courseInterval) >= 0 ? Number(message.courseInterval) : state.courseInterval,
          targetHours: Number(message.targetHours) >= 1 ? Number(message.targetHours) : state.targetHours
        });
        await chrome.storage.local.set({
          speedRate: state.speedRate,
          alertTimeout: state.alertTimeout,
          enableAlert: state.enableAlert,
          courseInterval: state.courseInterval,
          targetHours: state.targetHours
        });
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ error: 'unknown message type' });
    }
  })();
  return true;
});
