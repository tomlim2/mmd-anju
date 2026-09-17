(() => {
  const card = document.getElementById('compat-modal');
  const title = document.getElementById('compat-title');
  const description = document.getElementById('compat-description');
  const hint = document.getElementById('compat-hint');
  const publicUrl = 'https://tomlim2.github.io/mmd-anju/';

  function showUnavailable(reason) {
    if (reason === 'load') {
      title.textContent = '플레이어를 불러오지 못했어요';
      description.textContent = '네트워크 연결을 확인한 뒤 다시 접속해 주세요.';
    } else if (reason === 'secure') {
      title.textContent = '브라우저에서 열어주세요';
      description.textContent = '주소를 복사해 Chrome, Firefox 등 WebGPU를 지원하는 브라우저에서 열어주세요.';
      hint.textContent = '파일 미리보기나 보안 연결이 아닌 페이지에서는 재생이 제한돼요.';
      hint.hidden = false;
    } else if (reason === 'gpu') {
      title.textContent = '그래픽 기능을 시작하지 못했어요';
      description.textContent = 'Chrome, Firefox 등 WebGPU를 지원하는 브라우저에서 열어주세요.';
      hint.textContent = '이미 사용 중이라면 그래픽 가속 설정을 확인해 주세요.';
      hint.hidden = false;
    }
    card.hidden = false;
    for (const element of document.body.children) {
      if (element !== card && !['SCRIPT', 'STYLE'].includes(element.tagName)) element.setAttribute('inert', '');
    }
    document.getElementById('play-overlay').hidden = true;
    title.focus();
  }

  document.getElementById('compat-copy').addEventListener('click', async () => {
    const status = document.getElementById('compat-copy-status');
    status.hidden = false;
    try {
      await navigator.clipboard.writeText(publicUrl);
      status.textContent = '주소를 복사했어요.';
    } catch {
      const input = document.getElementById('compat-url');
      input.value = publicUrl;
      input.hidden = false;
      input.focus();
      input.select();
      status.textContent = '아래 주소를 직접 복사해 주세요.';
    }
  });

  if (!window.isSecureContext || location.protocol === 'file:') {
    showUnavailable('secure');
  } else if (!navigator.gpu) {
    showUnavailable('unsupported');
  } else {
    import('./startup.js')
      .then(({ startPlayer }) => startPlayer({
        gpu: navigator.gpu,
        loadPlayer: () => import('./main.js'),
        onUnavailable: showUnavailable,
      }))
      .catch(error => {
        console.error('Could not load startup checks:', error);
        showUnavailable('load');
      });
  }
})();
