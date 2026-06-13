// Minimal CSInterface shim for RIT demo.
// For production, download the official Adobe CSInterface.js from:
//   https://github.com/Adobe-CEP/CEP-Resources/tree/master/CEP_10.x
// This stub only implements the methods RIT uses (evalScript, getHostEnvironment).

function CSInterface() {
  this.hostEnvironment = (typeof window !== 'undefined' && window.__adobe_cep__)
    ? this.getHostEnvironment()
    : { appName: 'PPRO', appVersion: '0.0.0', appLocale: 'en_US' };
}

CSInterface.prototype.evalScript = function (script, callback) {
  if (typeof window !== 'undefined' && window.__adobe_cep__ && window.__adobe_cep__.evalScript) {
    window.__adobe_cep__.evalScript(script, callback || function () {});
  } else {
    // Running outside Premiere (browser preview). Fake a response so the panel
    // remains functional for layout development.
    if (callback) {
      setTimeout(function () {
        callback(JSON.stringify({ error: 'Not running inside Premiere (CEP host unavailable)' }));
      }, 0);
    }
  }
};

CSInterface.prototype.getHostEnvironment = function () {
  try {
    if (window.__adobe_cep__) return JSON.parse(window.__adobe_cep__.getHostEnvironment());
  } catch (e) {}
  return { appName: 'unknown', appVersion: '0.0.0', appLocale: 'en_US' };
};

CSInterface.prototype.getExtensionPath = function () {
  if (typeof window !== 'undefined' && window.__adobe_cep__ && window.__adobe_cep__.getSystemPath) {
    return window.__adobe_cep__.getSystemPath('extension');
  }
  return '';
};
