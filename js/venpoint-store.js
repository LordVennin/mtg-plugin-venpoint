/*
 * Venpoint storage adapter — active when the app runs inside a Venpoint
 * session (same origin, token in localStorage). Callers check available()
 * and fall back to the relay / localStorage path otherwise, so the
 * standalone / GitHub Pages mode keeps working unchanged.
 *
 * Contract (Venpoint side): Bearer <session token> against
 * /api/games/mtg/storage/<key>. Storage is per-account: 64KB per entry,
 * 32 entries, 512KB per game, rate-limited, no anonymous writes. Quota
 * refusals come back as {message} and are surfaced to the UI as-is.
 */
var VenpointStore = (function () {
  'use strict';

  function token() {
    try { return localStorage.getItem('venpoint.session.token'); } catch (e) { return null; }
  }

  function user() {
    try {
      var u = JSON.parse(localStorage.getItem('venpoint.session.user'));
      return (u && u.username) || null;
    } catch (e) { return null; }
  }

  function available() { return !!token(); }

  function call(method, key, body) {
    var headers = { 'Authorization': 'Bearer ' + token() };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch('/api/games/mtg/storage/' + key, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          var err = new Error(json.message || ('HTTP ' + res.status));
          err.status = res.status; // present = the server answered and refused
          throw err;
        });
      }
      return res.json();
    });
  }

  return {
    user: user,
    available: available,
    /** Every saved deck, {name: {text, updated}} — one storage entry. */
    loadDecks: function () {
      return call('GET', 'decks')
        .then(function (json) {
          try { return JSON.parse(json.value) || {}; } catch (e) { return {}; }
        })
        .catch(function (err) {
          if (err && err.status === 404) return {}; // nothing saved yet
          throw err;
        });
    },
    saveDecks: function (decks) {
      return call('PUT', 'decks', { value: JSON.stringify(decks) });
    }
  };
})();
