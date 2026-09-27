/**
 * The capture worklet: it does nothing but hand each audio frame back to the
 * page. It lives as a real file rather than a blob because the renderer's
 * Content-Security-Policy is `script-src 'self'` — and a policy that would
 * let this page run a generated script is not one worth relaxing for a
 * microphone.
 */
class OcakCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}

registerProcessor("ocak-capture", OcakCapture);
