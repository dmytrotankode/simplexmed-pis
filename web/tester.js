/**
 * Розділ «Тестування» кабінету «Плексі» — інтерактивні інструкції для тестувальників ДП «Електронне здоров'я».
 *
 * Самодостатній модуль: єдиний глобальний об'єкт PlexiTester, власні запити до /api/tester/*, без залежностей
 * від решти сторінки, окрім двох необов'язкових зв'язок (switchNav для переходу до розділу кабінету).
 * Для не-тестувальників сервер відповідає 404, і розділ у меню не з'являється.
 *
 *   PlexiTester.init({ base: '', onAvailable: () => {...} })
 *   PlexiTester.render(containerEl)
 */
(function (global) {
  'use strict';

  var state = { base: '', content: null, marks: {}, platform: 'web', filter: 'all', open: null };

  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function api(path, opts) {
    return fetch(state.base + '/api/tester' + path, Object.assign({ credentials: 'same-origin' }, opts || {}))
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); });
  }

  function markKey(id, platform) { return id + '|' + platform; }

  function statusOf(id) { var m = state.marks[markKey(id, state.platform)]; return m ? m.status : null; }

  function leafCoverage() {
    var nodes = state.content.tree.nodes, byParent = {};
    nodes.forEach(function (n) { if (n.parent) byParent[n.parent] = true; });
    var leaves = nodes.filter(function (n) { return n.applies && !byParent[n.id]; });
    var done = {};
    state.content.scenarios.forEach(function (s) {
      if (statusOf(s.id) !== 'ok') return;
      leaves.forEach(function (l) {
        if (s.covers.some(function (c) { return l.id === c || l.id.indexOf(c + '.') === 0; })) done[l.id] = true;
      });
    });
    return { total: leaves.length, done: Object.keys(done).length, leaves: leaves, doneMap: done };
  }

  function setMark(id, status, note) {
    return api('/marks', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario_id: id, platform: state.platform, status: status, note: note || '' })
    }).then(function (r) {
      if (r.ok) state.marks[markKey(id, state.platform)] = { status: status, note: note || '' };
      return r.ok;
    });
  }

  function clearMark(id) {
    return api('/marks/' + encodeURIComponent(id) + '?platform=' + state.platform, { method: 'DELETE' }).then(function (r) {
      if (r.ok) delete state.marks[markKey(id, state.platform)];
      return r.ok;
    });
  }

  var LABEL = { ok: 'Виконано', fail: 'Помилка', skip: 'Пропущено' };
  var COLOR = { ok: 'bg-blue-100 text-blue-800', fail: 'bg-amber-100 text-amber-800', skip: 'bg-slate-100 text-slate-700' };

  function card(s, root) {
    var st = statusOf(s.id), isOpen = state.open === s.id;
    var mark = state.marks[markKey(s.id, state.platform)] || {};
    var head = h('button', {
      type: 'button', class: 'w-full text-left flex items-start justify-between gap-3 p-4', 'aria-expanded': isOpen ? 'true' : 'false',
      onclick: function () { state.open = isOpen ? null : s.id; render(root); }
    },
      h('span', { class: 'min-w-0' },
        h('span', { class: 'block font-semibold text-slate-900' }, s.title),
        h('span', { class: 'block text-sm text-slate-600 mt-0.5' }, 'ТВ: ' + s.covers.join(', '))),
      st ? h('span', { class: 'status-badge shrink-0 ' + COLOR[st] }, LABEL[st]) : h('span', { class: 'text-sm text-slate-500 shrink-0' }, 'Не перевірено'));
    var body = null;
    if (isOpen) {
      var note = h('textarea', { rows: '2', maxlength: '2000', 'aria-label': 'Нотатка до сценарію',
        class: 'w-full mt-3 px-3 py-2 text-sm border border-slate-300 rounded-lg', placeholder: 'Нотатка: що побачили, код запиту ЕСОЗ, помилка…' });
      note.value = mark.note || '';
      var btn = function (status, cls) {
        return h('button', { type: 'button', class: 'min-h-[40px] px-3 rounded-lg text-sm font-semibold ' + cls,
          onclick: function () { setMark(s.id, status, note.value).then(function () { render(root); }); } }, LABEL[status]);
      };
      var go = null;
      if (s.where && typeof global.switchNav === 'function') {
        go = h('button', { type: 'button', class: 'min-h-[40px] px-3 rounded-lg border border-slate-300 text-sm font-semibold',
          onclick: function () { global.switchNav(s.where); } }, 'Перейти до розділу');
      }
      body = h('div', { class: 'px-4 pb-4 border-t border-slate-100' },
        h('p', { class: 'text-sm font-semibold text-slate-700 mt-3' }, 'Кроки'),
        h.apply(null, ['ol', { class: 'list-decimal pl-5 mt-1 space-y-1 text-sm text-slate-800' }].concat(
          s.steps.map(function (t) { return h('li', null, t); }))),
        h('p', { class: 'text-sm font-semibold text-slate-700 mt-3' }, 'Очікуваний результат'),
        h('p', { class: 'text-sm text-slate-800 mt-1' }, s.expect),
        note,
        h('div', { class: 'flex flex-wrap gap-2 mt-3' }, go,
          btn('ok', 'bg-blue-600 text-white'), btn('fail', 'border border-amber-300 text-amber-800'), btn('skip', 'border border-slate-300 text-slate-700'),
          st ? h('button', { type: 'button', class: 'min-h-[40px] px-3 text-sm text-slate-600 underline',
            onclick: function () { clearMark(s.id).then(function () { render(root); }); } }, 'Зняти відмітку') : null));
    }
    return h('div', { class: 'bg-white rounded-2xl border border-slate-200 overflow-hidden' }, head, body);
  }

  function groups(list) {
    var map = {}, order = [];
    list.forEach(function (s) {
      var key = (s.covers[0] || '').split('.')[0] === '3' ? s.covers[0].split('.').slice(0, 2).join('.') : (s.covers[0] || '').split('.')[0];
      if (!map[key]) { map[key] = []; order.push(key); }
      map[key].push(s);
    });
    return order.sort(function (a, b) { return parseFloat(a) - parseFloat(b); }).map(function (k) { return { key: k, items: map[k] }; });
  }

  function render(root) {
    if (!state.content) return;
    root.textContent = '';
    var cov = leafCoverage();
    var pct = cov.total ? Math.round(cov.done * 100 / cov.total) : 0;
    var tabs = ['web', 'android'].map(function (p) {
      return h('button', { type: 'button', 'aria-pressed': state.platform === p ? 'true' : 'false',
        class: 'min-h-[40px] px-3 rounded-lg text-sm font-semibold ' + (state.platform === p ? 'bg-white text-slate-900' : 'text-slate-600'),
        onclick: function () { state.platform = p; render(root); } }, p === 'web' ? 'Веб' : 'Android');
    });
    var filters = [['all', 'Усі'], ['todo', 'Не перевірені'], ['fail', 'З помилками']].map(function (f) {
      return h('button', { type: 'button', class: 'min-h-[36px] px-3 rounded-full text-sm ' + (state.filter === f[0] ? 'bg-blue-600 text-white' : 'border border-slate-300 text-slate-700'),
        onclick: function () { state.filter = f[0]; render(root); } }, f[1]);
    });
    root.appendChild(h('div', { class: 'bg-white rounded-2xl border border-slate-200 p-4 mb-4' },
      h('p', { class: 'text-sm text-slate-600' }, 'Інструкції для тестування кабінету «Плексі» за Технічними вимогами до ПІС (наказ НСЗУ № 978). ' +
        'Відкривайте сценарій, виконуйте кроки в кабінеті, ставте відмітку і за потреби нотатку.'),
      h('div', { class: 'flex flex-wrap items-center gap-3 mt-3' },
        h('span', { class: 'font-semibold text-slate-900' }, 'Покрито пунктів ТВ: ' + cov.done + ' з ' + cov.total + ' (' + pct + '%)'),
        h.apply(null, ['div', { class: 'flex gap-1 p-1 rounded-xl bg-slate-100', role: 'group', 'aria-label': 'Платформа' }].concat(tabs))),
      h('div', { class: 'mt-3 h-2 rounded-full bg-slate-100 overflow-hidden', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
        h('div', { class: 'h-2 bg-blue-600', style: 'width:' + pct + '%' })),
      h.apply(null, ['div', { class: 'flex flex-wrap gap-2 mt-3' }].concat(filters))));
    var list = state.content.scenarios.filter(function (s) {
      if (s.platforms.indexOf(state.platform) < 0) return false;
      var st = statusOf(s.id);
      return state.filter === 'all' || (state.filter === 'todo' && !st) || (state.filter === 'fail' && st === 'fail');
    });
    if (!list.length) root.appendChild(h('p', { class: 'text-slate-600' }, 'Немає сценаріїв за цим фільтром.'));
    groups(list).forEach(function (g) {
      root.appendChild(h('h2', { class: 'text-lg font-bold text-slate-900 mt-5 mb-2' }, 'Розділ ТВ ' + g.key));
      root.appendChild(h.apply(null, ['div', { class: 'space-y-2' }].concat(g.items.map(function (s) { return card(s, root); }))));
    });
    // Пункти ТВ, які ще не закриті відмітками «Виконано» на цій платформі
    var open = cov.leaves.filter(function (l) { return !cov.doneMap[l.id]; });
    if (open.length) {
      var det = h('details', { class: 'mt-6 bg-white rounded-2xl border border-slate-200 p-4' },
        h('summary', { class: 'cursor-pointer font-semibold text-slate-900' }, 'Пункти ТВ без відмітки «Виконано» (' + open.length + ')'),
        h.apply(null, ['ul', { class: 'mt-2 space-y-1 text-sm text-slate-700' }].concat(open.map(function (l) {
          return h('li', null, h('span', { class: 'font-mono' }, l.id + ' '), l.text.length > 160 ? l.text.slice(0, 157) + '…' : l.text);
        }))));
      root.appendChild(det);
    }
  }

  var PlexiTester = {
    /** Перевіряє, чи доступний розділ; onAvailable викликається, лише якщо сервер відповів 200. */
    init: function (opts) {
      opts = opts || {};
      state.base = opts.base || '';
      return Promise.all([api('/content'), api('/marks')]).then(function (res) {
        if (!res[0].ok) return false;
        state.content = res[0].body;
        (res[1].body.data || []).forEach(function (m) { state.marks[markKey(m.scenario_id, m.platform)] = m; });
        if (typeof opts.onAvailable === 'function') opts.onAvailable();
        return true;
      }).catch(function () { return false; });
    },
    render: function (root) { render(root); },
    available: function () { return !!state.content; }
  };

  global.PlexiTester = PlexiTester;
})(window);
