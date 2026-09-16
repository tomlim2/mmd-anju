// Keep capability checks independent of the browser UI for regression tests.
export async function startPlayer({ gpu, loadPlayer, onUnavailable, timeoutMs = 10000 }) {
  if (!gpu || typeof gpu.requestAdapter !== 'function') {
    onUnavailable('unsupported');
    return false;
  }
  let timer;
  try {
    const adapter = await Promise.race([
      gpu.requestAdapter(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('GPU detection timed out')), timeoutMs); }),
    ]);
    if (!adapter) {
      onUnavailable('gpu');
      return false;
    }
  } catch {
    onUnavailable('gpu');
    return false;
  } finally {
    clearTimeout(timer);
  }
  try {
    await loadPlayer();
    return true;
  } catch (error) {
    console.error('Player startup failed:', error);
    onUnavailable(error.name === 'WebGPUInitializationError' ? 'gpu' : 'load');
    return false;
  }
}
