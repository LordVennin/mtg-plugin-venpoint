/*
 * Decklist parsing — Moxfield / MTGO / Arena style text lists.
 *
 * Pure functions, no DOM, no network. Also loadable from Node for tests.
 */

var MTGParser = (function () {
  'use strict';

  var SECTION_HEADERS = /^(deck|main|maindeck|mainboard|sideboard|side|commander|companion|maybeboard|considering|tokens?)\s*:?\s*$/i;

  /**
   * Parse one line of a decklist.
   * Returns {count, name, set, collectorNumber} or null if the line is not a card line.
   *
   * Accepted forms:
   *   "4 Lightning Bolt"
   *   "4x Lightning Bolt"
   *   "Lightning Bolt"
   *   "1 Lightning Bolt (2X2) 117"
   *   "1 Lightning Bolt (2X2) 117 *F*"
   *   "SB: 2 Duress"          (MTGO sideboard prefix — treated as a normal card line)
   */
  function parseLine(rawLine) {
    var line = rawLine.trim();
    if (!line) return null;
    if (line.startsWith('//') || line.startsWith('#')) return null; // comment
    if (SECTION_HEADERS.test(line)) return null;

    line = line.replace(/^SB:\s*/i, '');

    var count = 1;
    var m = line.match(/^(\d+)\s*x?\s+(.*)$/i);
    if (m) {
      count = parseInt(m[1], 10);
      line = m[2];
    }

    // Strip foil/etched/tag markers at the end: *F*, *E*, #tag, ^...^
    line = line.replace(/\s*\*[A-Za-z]+\*\s*$/, '');
    line = line.replace(/\s*#[^\s#]+(\s+#[^\s#]+)*\s*$/, '');
    line = line.replace(/\s*\^[^^]*\^\s*$/, '');

    // Optional "(SET) 123" suffix
    var set = null, collectorNumber = null;
    var sm = line.match(/^(.*?)\s+\(([A-Za-z0-9]{2,6})\)\s*([\w-★†]+)?\s*$/);
    if (sm && sm[1]) {
      line = sm[1];
      set = sm[2].toUpperCase();
      collectorNumber = sm[3] || null;
    }

    var name = line.trim();
    if (!name || count < 1) return null;
    return { count: count, name: name, set: set, collectorNumber: collectorNumber };
  }

  /**
   * Parse a whole decklist. Returns {entries, errors}.
   * entries: [{count, name, set, collectorNumber}], duplicates merged by name.
   */
  function parseDeckList(text) {
    var entries = [];
    var byName = Object.create(null);
    var errors = [];
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (!raw.trim()) continue;
      var e = parseLine(raw);
      if (e === null) {
        // Comments and section headers are silently skipped; anything else that
        // failed to parse gets reported.
        var t = raw.trim();
        if (!t.startsWith('//') && !t.startsWith('#') && !SECTION_HEADERS.test(t)) {
          errors.push('Line ' + (i + 1) + ': could not parse "' + t + '"');
        }
        continue;
      }
      var key = e.name.toLowerCase();
      if (byName[key]) {
        byName[key].count += e.count;
      } else {
        byName[key] = e;
        entries.push(e);
      }
    }
    return { entries: entries, errors: errors };
  }

  /**
   * Expand parsed entries into a flat array of card names (one per copy).
   */
  function expandEntries(entries) {
    var out = [];
    entries.forEach(function (e) {
      for (var i = 0; i < e.count; i++) out.push(e.name);
    });
    return out;
  }

  /**
   * Printing pins from "(SET)" suffixes: lowercased name -> set code.
   * Lets a list like "1 Lightning Bolt (LEA)" resolve to that printing's
   * art instead of whatever printing Scryfall considers current.
   */
  function collectSetHints(entries) {
    var hints = Object.create(null);
    (entries || []).forEach(function (e) {
      if (e && e.set) hints[e.name.toLowerCase()] = e.set.toLowerCase();
    });
    return hints;
  }

  /**
   * Parse a bulk jumpstart-pack import. Pack headers are lines of one of:
   *   # Pack Name
   *   === Pack Name ===
   *   [Pack Name]
   * Cards follow each header. Text before any header (if it contains card
   * lines) becomes a pack named "Pack 1".
   *
   * Returns {packs: [{name, entries, cards}], errors}
   */
  function parseJumpstartPacks(text) {
    var lines = String(text || '').split(/\r?\n/);
    var packs = [];
    var errors = [];
    var current = null;

    function headerName(line) {
      var t = line.trim();
      var m = t.match(/^===\s*(.*?)\s*===$/) || t.match(/^\[(.+)\]$/) || t.match(/^#\s*(.+)$/);
      return m ? m[1].trim() : null;
    }

    function pushCurrent() {
      if (current && current.entries.length) {
        current.cards = expandEntries(current.entries);
        packs.push(current);
      }
      current = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var t = raw.trim();
      if (!t) continue;
      var hn = headerName(t);
      if (hn !== null) {
        pushCurrent();
        current = { name: hn || 'Pack ' + (packs.length + 1), entries: [] };
        continue;
      }
      var e = parseLine(t);
      if (e === null) {
        if (!SECTION_HEADERS.test(t) && !t.startsWith('//')) {
          errors.push('Line ' + (i + 1) + ': could not parse "' + t + '"');
        }
        continue;
      }
      if (!current) current = { name: 'Pack ' + (packs.length + 1), entries: [] };
      current.entries.push(e);
    }
    pushCurrent();
    return { packs: packs, errors: errors };
  }

  /**
   * Parse a decklist, also extracting commander designations. Commanders are
   * recognized two ways:
   *   - a "Commander" / "Commander:" section header — card lines that follow
   *     it (until the next section header) are commanders;
   *   - a "*CMDR*" marker on the line (Archidekt/TappedOut style).
   * Returns {entries, commanders: [names], errors}. Commander cards also
   * appear in entries (they are part of the deck).
   */
  function parseDeckListWithCommanders(text) {
    var entries = [];
    var byName = Object.create(null);
    var commanders = [];
    var errors = [];
    var inCommanderSection = false;
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var t = raw.trim();
      if (!t) continue;
      if (SECTION_HEADERS.test(t)) {
        inCommanderSection = /^commander/i.test(t);
        continue;
      }
      if (t.startsWith('//') || t.startsWith('#')) continue;
      var isCmdr = /\*CMDR\*/i.test(t);
      var e = parseLine(t.replace(/\*CMDR\*/ig, '').trim());
      if (e === null) {
        errors.push('Line ' + (i + 1) + ': could not parse "' + t + '"');
        continue;
      }
      var key = e.name.toLowerCase();
      if (byName[key]) byName[key].count += e.count;
      else { byName[key] = e; entries.push(e); }
      if ((isCmdr || inCommanderSection) && commanders.indexOf(e.name) === -1) {
        commanders.push(e.name);
      }
    }
    return { entries: entries, commanders: commanders, errors: errors };
  }

  /**
   * Format a list of card names back into a Moxfield-importable decklist.
   */
  function formatDeckList(cardNames) {
    var counts = Object.create(null);
    var order = [];
    (cardNames || []).forEach(function (n) {
      var key = n.toLowerCase();
      if (!counts[key]) { counts[key] = { name: n, count: 0 }; order.push(key); }
      counts[key].count++;
    });
    return order.map(function (k) { return counts[k].count + ' ' + counts[k].name; }).join('\n');
  }

  /**
   * Preset list files (the site owner drops these in lists/): a few
   * "@key value" metadata lines up top, then a normal list body in whatever
   * syntax the format uses (deck list, jumpstart packs, ...).
   *
   *   @name Ven's 360 Cube
   *   @format cube          (cube | jumpstart | deck | commander | vanguard)
   *   1 Lightning Bolt
   *   ...
   */
  function parsePresetFile(text) {
    var meta = {};
    var body = [];
    var inHead = true;
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var m = inHead && line.match(/^@(\w+)\s+(.+)$/);
      if (m) { meta[m[1].toLowerCase()] = m[2].trim(); return; }
      if (line.trim()) inHead = false; // first non-meta content line ends the header
      body.push(line);
    });
    return {
      name: meta.name || '',
      format: (meta.format || '').toLowerCase(),
      meta: meta,
      body: body.join('\n').replace(/^\n+/, '')
    };
  }

  return {
    parseLine: parseLine,
    parseDeckList: parseDeckList,
    parseDeckListWithCommanders: parseDeckListWithCommanders,
    parseJumpstartPacks: parseJumpstartPacks,
    parsePresetFile: parsePresetFile,
    expandEntries: expandEntries,
    collectSetHints: collectSetHints,
    formatDeckList: formatDeckList
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MTGParser;
