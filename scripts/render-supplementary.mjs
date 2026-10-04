// Scripted-page stimuli, separate from style-driven behavior and closure.
export async function stimulate(browser, log) {
  const page = await browser.newPage();
  try {
    await page.goto('https://tls.render.test:8443/scripted.html', { waitUntil: 'load', timeout: 5000 });
    const outcomes = await page.evaluate(async () => {
      const bounded = promise => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve('not observed within 1500 ms'), 1500))]);
      const sw = bounded(navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => 'registered').catch(e => e.message));
      const ws = bounded(new Promise(resolve => { const socket = new WebSocket('wss://tls.render.test:8443/ws'); socket.onopen = () => { socket.close(); resolve('opened'); }; socket.onerror = () => resolve('failed'); }));
      const rtc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:203.0.113.10:3478' }] });
      rtc.createDataChannel('probe');
      await rtc.setLocalDescription(await rtc.createOffer());
      const udp = await bounded(new Promise(resolve => { rtc.onicecandidate = event => { if (!event.candidate) resolve('gathering complete'); }; }));
      rtc.close();
      return { serviceWorker: await sw, webSocket: await ws, udp };
    });
    log({ event: 'scripted-stimulus', outcomes });
  } catch (error) { log({ event: 'scripted-stimulus', error: error.message }); }
  finally { await page.close(); }
}
