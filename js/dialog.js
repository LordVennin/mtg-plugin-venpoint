/*
 * In-page replacement for window.prompt(). Electron (the Venpoint desktop
 * shell's game window) deliberately does not implement prompt(), which
 * silently killed every feature built on it — card notes, library looks,
 * draw/mill counts, tokens, dice. This styled dialog works everywhere and
 * returns a Promise: resolve(string) on OK/Enter, resolve(null) on
 * Cancel/Escape/backdrop, mirroring prompt()'s contract.
 */
var Dlg = (function () {
  'use strict';

  function prompt(message, def) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'dlg-overlay';
      overlay.innerHTML =
        '<div class="dlg">' +
          '<div class="dlg-msg"></div>' +
          '<input class="dlg-input" type="text">' +
          '<div class="dlg-actions">' +
            '<button type="button" class="dlg-cancel">Cancel</button>' +
            '<button type="button" class="dlg-ok primary">OK</button>' +
          '</div>' +
        '</div>';
      overlay.querySelector('.dlg-msg').textContent = String(message);
      var input = overlay.querySelector('.dlg-input');
      input.value = def == null ? '' : String(def);

      function close(value) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(value);
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.preventDefault();
          close(null);
        } else if (e.key === 'Enter') {
          e.stopPropagation();
          e.preventDefault();
          close(input.value);
        }
      }

      overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay) close(null);
      });
      overlay.querySelector('.dlg-cancel').addEventListener('click', function () { close(null); });
      overlay.querySelector('.dlg-ok').addEventListener('click', function () { close(input.value); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      input.focus();
      input.select();
    });
  }

  /** prompt() that parses the answer as an integer; null when cancelled or not a number. */
  function promptNumber(message, def) {
    return prompt(message, def).then(function (value) {
      if (value === null) return null;
      var n = parseInt(value, 10);
      return isNaN(n) ? null : n;
    });
  }

  return { prompt: prompt, promptNumber: promptNumber };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Dlg;
