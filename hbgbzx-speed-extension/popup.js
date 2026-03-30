document.addEventListener('DOMContentLoaded', () => {
  const btnStart = document.getElementById('btnStart');
  const statusPanel = document.getElementById('statusPanel');
  const statusBadge = document.getElementById('statusBadge');
  const currentCourse = document.getElementById('currentCourse');
  const courseProgress = document.getElementById('courseProgress');
  const currentSection = document.getElementById('currentSection');
  const sectionProgress = document.getElementById('sectionProgress');
  const earnedHours = document.getElementById('earnedHours');
  const playbackTime = document.getElementById('playbackTime');
  const videoProgress = document.getElementById('videoProgress');
  const watchProgress = document.getElementById('watchProgress');
  const progressBar = document.getElementById('progressBar');
  const speedRate = document.getElementById('speedRate');
  const courseInterval = document.getElementById('courseInterval');
  const settingsToggle = document.getElementById('settingsToggle');
  const settingsArrow = document.getElementById('settingsArrow');
  const settingsBody = document.getElementById('settingsBody');
  const targetHours = document.getElementById('targetHours');
  const toast = document.getElementById('toast');

  let currentStatus = 'IDLE';

  settingsToggle.addEventListener('click', () => {
    settingsBody.classList.toggle('open');
    settingsArrow.classList.toggle('open');
  });

  const clampRate = value => Math.max(1, Math.min(1.5, Number(value) || 1.5));

  chrome.storage.local.get({ speedRate: 1.5, courseInterval: 2, targetHours: 50 }, saved => {
    speedRate.value = String(clampRate(saved.speedRate));
    courseInterval.value = saved.courseInterval;
    targetHours.value = saved.targetHours;
  });

  let toastTimer = null;
  function showToast(msg, durationMs = 5000) {
    toast.textContent = msg;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.classList.remove('show'); }, durationMs);
  }

  function saveSettings() {
    chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      speedRate: parseFloat(speedRate.value),
      courseInterval: parseFloat(courseInterval.value) || 2,
      targetHours: parseInt(targetHours.value, 10) || 50
    }).catch(() => {});
  }

  [speedRate, courseInterval, targetHours].forEach(element => {
    element.addEventListener('change', saveSettings);
  });

  btnStart.addEventListener('click', () => {
    if (currentStatus === 'IDLE' || currentStatus === 'COMPLETED' || currentStatus === 'ERROR') {
      const th = parseInt(targetHours.value, 10) || 50;
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, resp => {
        if (chrome.runtime.lastError) return;
        const earned = Number(resp?.earnedHours) || 0;
        if (earned >= th) {
          showToast(`已获得 ${earned.toFixed(2)} 学时，已达目标 ${th} 学时，无需继续学习。如需继续学习请修改目标学时。`, 6000);
          return;
        }
        chrome.runtime.sendMessage({ type: 'START_AUTO_LEARN' }).catch(() => {});
        btnStart.textContent = '正在启动...';
        btnStart.disabled = true;
        setTimeout(() => { btnStart.disabled = false; }, 3000);
      });
      return;
    }
    chrome.runtime.sendMessage({ type: 'STOP_AUTO_LEARN' }).catch(() => {});
  });

  const statusMap = {
    IDLE: { text: '待机', cls: 'idle' },
    SCRAPING: { text: '获取课程中...', cls: 'scraping' },
    LEARNING: { text: '学习中', cls: 'learning' },
    SWITCHING: { text: '切换课程中...', cls: 'switching' },
    RESTING: { text: '休息中', cls: 'switching' },
    COMPLETED: { text: '已完成', cls: 'completed' },
    ERROR: { text: '出错', cls: 'error' }
  };

  function formatSeconds(value) {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  let prevStatus = 'IDLE';
  function updateUI(state) {
    if (!state) return;
    const newStatus = state.status || 'IDLE';
    if (newStatus === 'COMPLETED' && prevStatus !== 'COMPLETED' && state.lastResultNote?.includes('达到目标')) {
      showToast(state.lastResultNote, 6000);
    }
    prevStatus = newStatus;
    currentStatus = newStatus;

    if (currentStatus === 'IDLE' || currentStatus === 'COMPLETED' || currentStatus === 'ERROR') {
      btnStart.textContent = '开始学习';
      btnStart.classList.remove('running');
    } else {
      btnStart.textContent = '停止学习';
      btnStart.classList.add('running');
    }
    btnStart.disabled = false;

    const active = currentStatus !== 'IDLE' || Number(state.earnedHours) >= 0;
    statusPanel.classList.toggle('visible', active);

    const badge = statusMap[currentStatus] || statusMap.IDLE;
    statusBadge.textContent = badge.text;
    statusBadge.className = `status-badge ${badge.cls}`;

    const restText = state.restMinutesLeft > 0 ? `休息中，约 ${state.restMinutesLeft} 分钟后继续` : '休息中，稍后继续学习';
    const courseText = state.error
      ? state.error
      : currentStatus === 'RESTING'
        ? `${state.currentCourseTitle || '当前课程'} 已结束`
        : (state.currentCourseTitle || '-');
    currentCourse.textContent = courseText;
    currentCourse.title = courseText;
    currentCourse.style.color = state.error ? '#e74c3c' : '';

    courseProgress.textContent = `本轮已学 ${state.completedCourses || 0} 个`;
    earnedHours.textContent = Number.isFinite(Number(state.earnedHours)) ? `${Number(state.earnedHours).toFixed(2)} 学时` : '-';
    playbackTime.textContent = Number(state.currentVideoDuration) > 0
      ? `${formatSeconds(state.currentPlaybackTime)} / ${formatSeconds(state.currentVideoDuration)}`
      : '-';
    videoProgress.textContent = Number(state.currentVideoDuration) > 0
      ? `${Number(state.currentVideoProgress || 0).toFixed(2)}%`
      : '-';
    const hasWatchData = Number(state.currentVideoDuration) > 0 || Number(state.currentLessonLocation) > 0 || Number(state.currentSessionTime) > 0 || !!state.lastResultNote || currentStatus !== 'IDLE';
    const progressText = hasWatchData
      ? `课程${Number(state.currentCourseProgress || 0).toFixed(2)}% · 已提交${Math.round(Number(state.currentLessonLocation) || 0)}s · 本次${Math.round(Number(state.currentSessionTime) || 0)}s`
      : '-';
    watchProgress.textContent = currentStatus === 'RESTING'
      ? `${progressText} · ${restText}`
      : (state.lastResultNote ? `${progressText} · ${state.lastResultNote}` : progressText);
    currentSection.textContent = currentStatus === 'RESTING' ? '休息中' : (state.currentSection || '-');
    currentSection.title = currentStatus === 'RESTING' ? restText : (state.currentSection || '');

    if (state.totalSections > 0) {
      const index = (state.currentSectionIndex || 0) + 1;
      sectionProgress.textContent = `${index} / ${state.totalSections}`;
      progressBar.style.width = `${Math.round(((state.currentSectionIndex || 0) / state.totalSections) * 100)}%`;
    } else {
      sectionProgress.textContent = '-';
      progressBar.style.width = '0%';
    }
  }

  function pollState() {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, response => {
      if (chrome.runtime.lastError) return;
      updateUI(response);
    });
  }

  chrome.storage.onChanged.addListener(changes => {
    if (changes.autoLearnState) updateUI(changes.autoLearnState.newValue);
  });

  pollState();
});
