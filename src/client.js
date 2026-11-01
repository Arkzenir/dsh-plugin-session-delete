// dsh-plugin-session-delete — CLIENT half.
//
// One shared delete dialog for every entry point:
//   - sidebar session-row "..." menu row   (sidebar.workspaces.session.menu.item,
//                                           order 500: after pin/rename/fork/
//                                           archive/session-id)
//   - header danger button                 (conversation.session.header.actions,
//                                           order 30)
// Both entry points open a root-scoped shell.overlay dialog through one small
// request store, so the menu row never navigates and the header button never
// has to reach into the sidebar DOM.
//
// After a successful delete the client list is refreshed in place
// (`sessions.refresh()`): the Session Controller rebuilds its baseline from
// `session.list` and drops identities the host no longer reports, so no page
// reload is needed. When the deleted session was the one on screen, the next
// remaining session is opened through `uiWorkspace.openSession()`.
//
// Locale: all copy lives in the zh/en dictionaries below and follows the
// client's active language through the `locale` service (the `t` seat for slot
// entries, `locale.register` for the dictionaries). A composition without the
// locale service falls back to a browser-language sniff.
//
// Bundle format (client-modules protocol): classic script registering a
// factory via window.__ModuleLoader__.load({ id, factory }); the factory
// receives `require` and returns the plugin's exports (apply etc.).
// No JSX: plain React.createElement. Only platform-seeded modules are required
// (react, @deepseek-ai/dsh-client-ui-primitives).
window.__ModuleLoader__.load({
  id: '@arkzenir/dsh-plugin-session-delete',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useState } = React
    const { Button, IconTrashOutlineRegular, MenuItemButton, Modal } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'session-delete'
    const HEADER_SLOT = 'conversation.session.header.actions'
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const OVERLAY_SLOT = 'shell.overlay'
    const MENU_ITEM_ID = 'session-delete'
    const DIALOG_ID = 'session-delete-dialog'
    const DELETE_ROUTE = '/__session-delete/delete'

    // --- locale -----------------------------------------------------------------

    const zhDict = {
      'dialog.title': '删除会话',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除',
      'dialog.confirming': '删除中…',
      'dialog.untitled': '未命名会话',
      'dialog.session': '会话：',
      'dialog.sessionId': '序列号：',
      'dialog.runningWarn': '⚠ 会话正在运行',
      'dialog.ack': '我已了解后果，确认删除',
      'dialog.runningDesc': '该会话正在运行，删除会立即停止其任务并永久删除，正在进行的操作将中断且无法恢复。',
      'dialog.deleteDesc': '将永久删除该会话及其全部对话记录（会话日志、投影缓存与工作区记账），此操作不可恢复。',
      'button.title': '删除会话',
      'button.titleRunning': '删除会话（运行中，删除将停止任务）',
      'menu.delete': '删除会话',
      'error.untitled': '未知错误',
    }

    const enDict = {
      'dialog.title': 'Delete session',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.confirming': 'Deleting…',
      'dialog.untitled': 'Untitled session',
      'dialog.session': 'Session: ',
      'dialog.sessionId': 'Session ID: ',
      'dialog.runningWarn': '⚠ Session is running',
      'dialog.ack': 'I understand the consequences. Confirm deletion',
      'dialog.runningDesc': 'This session is running. Deleting it will stop its task immediately and remove it permanently; any work in progress will be interrupted and cannot be recovered.',
      'dialog.deleteDesc': 'This will permanently delete the session and all of its conversation records (session log, projection cache and workspace accounting). This action cannot be undone.',
      'button.title': 'Delete session',
      'button.titleRunning': 'Delete session (running — deleting will stop the task)',
      'menu.delete': 'Delete session',
      'error.untitled': 'Unknown error',
    }

    // Client locale service handle, refreshed by apply(). Slot components get
    // the `t` seat when the composition has a locale face; this handle keeps
    // the same copy working when it does not.
    let localeService = null

    function fallbackLanguage() {
      if (typeof navigator === 'undefined') return 'zh'
      const tags = (navigator.languages || []).concat([navigator.language])
      for (const tag of tags) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    function translate(key) {
      if (localeService && typeof localeService.translate === 'function') {
        const text = localeService.translate(NS, key)
        if (typeof text === 'string' && text !== key) return text
      }
      const dict = fallbackLanguage() === 'en' ? enDict : zhDict
      return dict[key] || key
    }

    // The `t` seat when the entry declares `locale: NS`, else the module-level
    // lookup. Components never require the seat.
    function translatorOf(props) {
      const seat = props && props.t
      if (typeof seat === 'function') return seat
      return translate
    }

    // --- pending delete request ---------------------------------------------------
    // A tiny observable store: the slot entries share it through `inject`, and
    // the overlay binds `hooks: { deleteRequest }` into a `useDeleteRequest`
    // selector hook. Cleared when the dialog settles.

    function createRequestStore() {
      let value = null
      const listeners = new Set()
      return {
        getSnapshot() { return value },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          value = next
          for (const listener of [...listeners]) {
            try { listener() } catch { /* a crashed subscriber must not break the store */ }
          }
        },
      }
    }

    // --- styles (theme tokens only; the plugin ships no stylesheet) ---------------

    const metaStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      fontSize: 13,
      lineHeight: '20px',
      margin: '0 0 10px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }

    const warnStyle = {
      color: 'var(--dsw-alias-state-warn-primary, #f5a524)',
      fontSize: 13,
      lineHeight: '20px',
      margin: '0 0 10px',
    }

    const ackStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary, inherit)',
      marginTop: 12,
    }

    const statusStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      fontSize: 12,
      lineHeight: '16px',
      marginTop: 8,
    }

    const errorStyle = {
      color: 'var(--dsw-alias-state-error-primary, #e5484d)',
      fontSize: 12,
      lineHeight: '16px',
      marginTop: 8,
    }

    // The primitives' Button has no danger variant (ghost/primary/outline), so
    // the destructive action keeps the primary geometry and overrides its
    // colors with the theme's error tokens.
    const dangerButtonStyle = {
      borderColor: 'var(--dsw-alias-state-error-primary, #e5484d)',
      background: 'var(--dsw-alias-state-error-primary, #e5484d)',
      color: '#fff',
    }

    const iconButtonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 28,
      height: 28,
      padding: 0,
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      cursor: 'pointer',
      flex: 'none',
    }

    function sessionRowOf(useSessions, sessionId) {
      if (typeof useSessions !== 'function') return undefined
      return useSessions((state) => (state && state.byId ? state.byId[sessionId] : undefined))
    }

    // --- sidebar session-row menu row ---------------------------------------------

    function DeleteSessionMenuItem(props) {
      const { sessionId, useMenuOpenState, requestDelete } = props
      const t = translatorOf(props)
      // Owner-injected hook (slot hook context "MenuOpenState"): closing the menu
      // before the dialog opens keeps the row from taking the dialog down with
      // it. A composition that renders this slot without the hook still works —
      // the menu then closes on its own dismiss path.
      const menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : [false, () => {}]
      const setMenuOpen = menuState[1]
      const onSelect = useCallback(() => {
        setMenuOpen(false)
        requestDelete(sessionId)
      }, [sessionId, requestDelete, setMenuOpen])
      return React.createElement(MenuItemButton, {
        icon: React.createElement(IconTrashOutlineRegular, { size: 14 }),
        danger: true,
        separatorBefore: true,
        onSelect,
      }, t('menu.delete'))
    }

    // --- header danger button -------------------------------------------------------

    function DeleteSessionButton(props) {
      const { sessionId, useSessions, requestDelete } = props
      const t = translatorOf(props)
      const summary = sessionRowOf(useSessions, sessionId)
      const running = summary ? summary.running === true : false
      const label = running ? t('button.titleRunning') : t('button.title')
      const onClick = useCallback(() => { requestDelete(sessionId) }, [sessionId, requestDelete])
      return React.createElement('button', {
        type: 'button',
        title: label,
        'aria-label': t('button.title'),
        style: iconButtonStyle,
        onClick,
      }, React.createElement(IconTrashOutlineRegular, { size: 16 }))
    }

    // --- shared delete dialog (root overlay) ---------------------------------------

    function DeleteSessionDialog(props) {
      const { useDeleteRequest, settleDelete, deleteSession, useSessions } = props
      const t = translatorOf(props)
      const request = useDeleteRequest((value) => value)
      if (!request) return null
      return React.createElement(DeleteSessionForm, {
        // Per-request instance: acknowledgement, busy and error state belong to
        // one request and die with it.
        key: request.sessionId,
        sessionId: request.sessionId,
        settleDelete,
        deleteSession,
        useSessions,
        t,
      })
    }

    function DeleteSessionForm({ sessionId, settleDelete, deleteSession, useSessions, t }) {
      const summary = sessionRowOf(useSessions, sessionId)
      const displayTitle = summary && summary.displayTitle ? summary.displayTitle : t('dialog.untitled')
      const running = summary ? summary.running === true : false
      const [acknowledged, setAcknowledged] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      const close = useCallback(() => {
        if (busy) return
        settleDelete()
      }, [busy, settleDelete])

      const confirm = useCallback(() => {
        if (busy || !acknowledged) return
        setBusy(true)
        setError(null)
        Promise.resolve(deleteSession(sessionId)).then(() => {
          settleDelete()
        }, (reason) => {
          setBusy(false)
          setError(reason instanceof Error && reason.message ? reason.message : t('error.untitled'))
        })
      }, [acknowledged, busy, deleteSession, sessionId, settleDelete, t])

      const footer = React.createElement(React.Fragment, null,
        React.createElement(Button, { variant: 'outline', disabled: busy, onClick: close }, t('dialog.cancel')),
        React.createElement(Button, {
          variant: 'primary',
          disabled: busy || !acknowledged,
          onClick: confirm,
          style: dangerButtonStyle,
        }, busy ? t('dialog.confirming') : t('dialog.confirm')))

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        closeLabel: t('dialog.cancel'),
        title: t('dialog.title'),
        description: running ? t('dialog.runningDesc') : t('dialog.deleteDesc'),
        footer,
      }, React.createElement('div', null,
        React.createElement('div', { key: 'meta', style: metaStyle },
          t('dialog.session'), displayTitle,
          React.createElement('br'),
          t('dialog.sessionId'), sessionId),
        running ? React.createElement('div', { key: 'warn', style: warnStyle }, t('dialog.runningWarn')) : null,
        React.createElement('label', { key: 'ack', style: ackStyle },
          React.createElement('input', {
            type: 'checkbox',
            checked: acknowledged,
            disabled: busy,
            'data-modal-autofocus': true,
            onChange: (event) => setAcknowledged(event.currentTarget.checked),
          }),
          t('dialog.ack')),
        busy ? React.createElement('div', { key: 'busy', style: statusStyle, role: 'status' }, t('dialog.confirming')) : null,
        error ? React.createElement('div', { key: 'error', style: errorStyle, role: 'alert' }, error) : null,
      ))
    }

    // --- apply ----------------------------------------------------------------------

    function apply(ctx) {
      const requests = createRequestStore()

      // Dictionaries: registered once per plugin fiber and removed on unload.
      // A composition without the locale service simply keeps the fallback.
      const locale = ctx.get('locale') || null
      localeService = locale
      if (locale && typeof locale.register === 'function') {
        try {
          ctx.effect(() => locale.register(NS, { zh: zhDict, en: enDict }), 'session-delete: dictionaries')
        } catch { /* namespace or locale already registered: keep the existing copy */ }
      }
      // `locale: NS` gives the registered components the `t` seat; without a
      // locale face the seat would throw at assembly, so it is only declared
      // when the service exists.
      const localeOption = locale ? { locale: NS } : {}

      const requestDelete = (sessionId) => {
        const id = String(sessionId || '')
        if (!id) return
        requests.set({ sessionId: id })
      }

      // The host performs the delete; the client only refreshes its own list.
      const deleteSession = async (sessionId) => {
        let response
        try {
          response = await fetch(DELETE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
        } catch (reason) {
          throw new Error(reason instanceof Error && reason.message ? reason.message : 'delete request failed')
        }
        let payload = {}
        try { payload = await response.json() } catch { /* empty or non-JSON body */ }
        if (!response.ok || payload.ok !== true) {
          throw new Error(payload && payload.error ? payload.error : `delete failed (HTTP ${response.status})`)
        }
        refreshAfterDelete(ctx, sessionId)
        return payload
      }

      ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
        name: MENU_SLOT,
        id: MENU_ITEM_ID,
        order: 500,
        ...localeOption,
        inject: () => ({ requestDelete }),
      }, DeleteSessionMenuItem))

      ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
        name: HEADER_SLOT,
        id: MENU_ITEM_ID,
        order: 30,
        ...localeOption,
        inject: () => ({ requestDelete }),
      }, DeleteSessionButton))

      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: DIALOG_ID,
        order: 100,
        ...localeOption,
        inject: () => ({
          hooks: { deleteRequest: requests },
          settleDelete: () => requests.set(null),
          deleteSession,
        }),
      }, DeleteSessionDialog))
    }

    // Re-pull the session baseline and, when the deleted session was the one on
    // screen, open the next remaining session. `refresh()` replaces the
    // ClientSession baseline and drops identities the host no longer reports;
    // the on-screen session is the row retained by the main view.
    function refreshAfterDelete(ctx, sessionId) {
      const sessions = ctx.get('sessions')
      if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return
      let wasCurrent = false
      try {
        const before = sessions.list.getSnapshot()
        const row = before && before.byId ? before.byId[sessionId] : undefined
        wasCurrent = !!(row && row.retainedBy && row.retainedBy.mainView > 0)
      } catch { /* list not ready */ }
      const refresh = typeof sessions.refresh === 'function' ? sessions.refresh() : undefined
      Promise.resolve(refresh).then(() => {
        if (!wasCurrent) return
        const workspace = ctx.get('uiWorkspace')
        if (!workspace || typeof workspace.openSession !== 'function') return
        try {
          const after = sessions.list.getSnapshot()
          const ids = after && Array.isArray(after.ids) ? after.ids : []
          const next = ids.find((id) => id !== sessionId)
          if (next) workspace.openSession(next)
        } catch { /* nothing left to open */ }
      }).catch(() => { /* the next baseline pull recovers */ })
    }

    // The loader gates apply() until the declared services exist.
    return { apply, inject: ['slots'] }
  },
})
