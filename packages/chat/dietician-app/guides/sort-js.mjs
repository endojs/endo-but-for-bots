// guides/sort-js.mjs — the guides' shared client script (text search + geolocation "nearest first" proximity
// sort), as a string so the package writes site/sort.js with no extra asset to ship. Ported verbatim from the
// persona's sort.js (byte-identical between the two guides). No backticks/${ inside, so the template literal
// is safe; the \u{...} emoji escapes resolve to the emoji chars (functionally identical to the source).
export const SORT_JS = `// Text search filter — substring match on each card's full text content.
(function () {
  var input = document.getElementById('text-filter');
  if (!input) return;
  function apply() {
    var q = input.value.trim().toLowerCase();
    document.body.classList.toggle('text-filtering', q.length > 0);
    var cards = document.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!c._searchHay) c._searchHay = c.textContent.toLowerCase();
      if (!q || c._searchHay.indexOf(q) !== -1) {
        c.classList.remove('search-hidden');
      } else {
        c.classList.add('search-hidden');
      }
    }
  }
  input.addEventListener('input', apply);
  input.addEventListener('search', apply);
})();

(function () {
  var btn = document.getElementById('sort-proximity');
  if (!btn) return;
  if (!navigator.geolocation) {
    btn.textContent = '\\u{1F4CD} Location unsupported';
    btn.disabled = true;
    return;
  }
  function toRad(d) { return (d * Math.PI) / 180; }
  function haversineMi(lat1, lng1, lat2, lng2) {
    var R = 3958.8;
    var dp = toRad(lat2 - lat1);
    var dl = toRad(lng2 - lng1);
    var a = Math.sin(dp / 2) * Math.sin(dp / 2)
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
          * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function applySort(ulat, ulng) {
    var cards = document.querySelectorAll('.card[data-lat][data-lng]');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var lat = parseFloat(c.dataset.lat);
      var lng = parseFloat(c.dataset.lng);
      if (isNaN(lat) || isNaN(lng)) continue;
      var d = haversineMi(ulat, ulng, lat, lng);
      c.style.order = String(Math.round(d * 1000));
      var meta = c.querySelector('.meta');
      if (meta) {
        var prev = meta.querySelector('.user-dist');
        if (prev) prev.remove();
        var sep = meta.querySelector('.user-dist-sep');
        if (sep) sep.remove();
        var dot = document.createElement('span');
        dot.className = 'user-dist-sep';
        dot.textContent = ' · ';
        var span = document.createElement('span');
        span.className = 'user-dist';
        span.textContent = d.toFixed(2) + ' mi from you';
        if (meta.childNodes.length) meta.appendChild(dot);
        meta.appendChild(span);
      }
    }
  }
  btn.addEventListener('click', function () {
    if (btn.classList.contains('locating')) return;
    btn.classList.add('locating');
    btn.textContent = '\\u{1F4CD} Locating…';
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        applySort(pos.coords.latitude, pos.coords.longitude);
        btn.textContent = '\\u{1F4CD} Sorted (nearest first)';
        btn.classList.remove('locating');
        btn.classList.add('active');
      },
      function (err) {
        var msg;
        if (err && err.code === 1) msg = '\\u{1F4CD} Location denied';
        else if (err && err.code === 2) msg = '\\u{1F4CD} Location unavailable';
        else if (err && err.code === 3) msg = '\\u{1F4CD} Location timed out';
        else msg = '\\u{1F4CD} Location error';
        btn.textContent = msg;
        btn.classList.remove('locating');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  });
})();
`;
