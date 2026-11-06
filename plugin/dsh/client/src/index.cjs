'use strict';
// Client entry: registers the right-sidebar page type and its body. Everything about DSH's client
// API is confined to this file, so a change in a later release is one place to fix (ADR 0003).
const React = require('react');
const { createViews } = require('./view.cjs');

const ID = 'dsh-token-economizer';
const KIND = 'token-economizer';
const STATUS_LINE = '/te panel --json';

/** `/te panel --json` (status plus the session series) in the given session. The slot hands the panel its session (see `apply`). */
function fetchStatusFor(ctx) {
  return async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: { message: 'Open a session first: /te runs inside one.' } };
    return ctx.remote.commands.execute(sessionId, STATUS_LINE, []);
  };
}

function apply(ctx) {
  const { createPanel } = createViews(React);
  const Panel = createPanel(fetchStatusFor(ctx));
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: KIND,
    title: () => 'TokenEconomizer',
    guide: [{ id: 'open', order: 900, title: () => 'TokenEconomizer', description: () => 'Learned facts, tool pruning, loop guard and what they cost.' }],
  }), 'token-economizer: sidebar type');
  // The tab slot is session-scoped, so the framework calls `inject` with the session the tab lives in
  // and hands the result to the component as props (the built-in plan page does the same).
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID, inject: (sessionId) => ({ sessionId }) }, Panel));
}

module.exports = { name: ID, inject: ['slots', 'remote', 'remote.commands', 'sidebarRightTabs'], apply, ID, KIND, STATUS_LINE };
