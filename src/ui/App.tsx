import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useBoxMetrics, useInput, useStdout, type DOMElement, type Key } from 'ink'
import { GROUP_TAB, NEW_TAB, describeStatus, type Squad } from '../squad.js'
import { Transcript } from './Transcript.js'
import {
  AgentForm,
  editableFields,
  emptyDraft,
  initialNewAgentState,
  type NewAgentState,
} from './AgentForm.js'
import { listTemplates, type Template } from '../library.js'
import { draftToProfile, profileToDraft } from '../draft.js'
import type { AgentProfile, AgentStatus } from '../types.js'
import { hitTest, installMouse, isLeftClick, parseMouse, type Rect } from './mouse.js'
import { computeLayout, noticeHeight, noticeWidth, MAX_NOTICE_ROWS, terminalSize } from './layout.js'
import * as composer from './composer.js'
import type { Composer } from './composer.js'

const HELP = [
  'Tab ⇧Tab       switch tabs',
  '← →            move the cursor; switch tabs when the box is empty',
  '↑ ↓            move a line; input history when the box is one line',
  '⌥← ⌥→          move a word    ^A / ^E  start / end of line',
  '^D              delete forward',
  '\\ then ⏎       newline (⌥⏎ too, where the terminal sends it)',
  'esc             dismiss the notice above the composer',
  '^E              edit the current agent\u2019s configuration (empty box)',
  '^K              interrupt the current agent',
  '/status         every agent’s state, branch and session',
  '/cost           spend per agent',
  '/stop [agent]   interrupt an agent',
  '/new            jump to the + tab to add an agent',
  '/quit           shut the squad down and exit',
].join('\n')

function statusColor(status: AgentStatus): string {
  switch (status.kind) {
    case 'thinking':
    case 'tool':
      return 'yellow'
    case 'idle':
      return 'green'
    case 'error':
      return 'red'
    default:
      return 'gray'
  }
}

function statusDot(status: AgentStatus): string {
  switch (status.kind) {
    case 'thinking':
    case 'tool':
      return '●'
    case 'error':
      return '✕'
    default:
      return '○'
  }
}

/**
 * One tab, which reports its own measured position so a click can be mapped back to it.
 * Measuring beats computing widths by hand: it stays correct as labels change, and it
 * handles the tab bar wrapping onto a second row for free.
 */
function TabLabel({
  label,
  color,
  active,
  suffix,
  onMeasure,
}: {
  label: string
  color: string
  active: boolean
  suffix: string
  onMeasure: (rect: Rect) => void
}) {
  const ref = useRef<DOMElement | null>(null)
  const metrics = useBoxMetrics(ref)
  useEffect(() => {
    if (metrics.hasMeasured) {
      onMeasure({ left: metrics.left, top: metrics.top, width: metrics.width, height: metrics.height })
    }
  }, [metrics.hasMeasured, metrics.left, metrics.top, metrics.width, metrics.height, onMeasure])

  return (
    <Box ref={ref} marginRight={1}>
      <Text inverse={active} color={color} bold={active}>
        {' '}
        {label}
        {suffix}{' '}
      </Text>
    </Box>
  )
}

export function App({ squad }: { squad: Squad }) {
  const { exit } = useApp()
  const { stdout } = useStdout()

  const [activeId, setActiveId] = useState(() => {
    const last = squad.lastTab
    return last && squad.tabs.some(t => t.id === last) ? last : GROUP_TAB
  })
  const [drafts, setDrafts] = useState<Record<string, Composer>>({})
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined)
  const [newAgent, setNewAgent] = useState<NewAgentState>(initialNewAgentState)
  const [editing, setEditing] = useState<string | undefined>(undefined)
  // The half-written new agent is kept aside while editing an existing one, so opening
  // an editor never throws away a draft.
  const stashed = useRef<NewAgentState | undefined>(undefined)
  const tabBarRef = useRef<DOMElement | null>(null)
  const tabRects = useRef(new Map<string, Rect>())
  const [templates, setTemplates] = useState<Template[]>([])
  const capabilities = useMemo(() => squad.availableCapabilities(), [squad])
  const [, forceRender] = useState(0)
  const [notice, setNotice] = useState<string | undefined>(
    squad.warnings.length ? squad.warnings.join(' ') : undefined,
  )
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (!stdout?.isTTY) return
    // Some hosts embed the TUI in a pane that does not implement the alternate screen.
    // SQUAD_NO_MOUSE=1 keeps the app on the normal screen; click-to-switch goes with it,
    // because without the alternate screen there is no way to know which physical row the
    // app starts on, so clicks could not be mapped to tabs reliably.
    if (process.env.SQUAD_NO_MOUSE === '1') return
    // 1 is stdout: the restore must be written synchronously to the fd on exit.
    return installMouse(data => stdout.write(data), 1)
  }, [stdout])

  useEffect(() => {
    // A host that reports its size late (or resizes the pane) must redraw, or the app
    // stays laid out for the size it guessed at startup.
    const onResize = () => forceRender(n => n + 1)
    stdout?.on('resize', onResize)
    return () => {
      stdout?.off('resize', onResize)
    }
  }, [stdout])

  useEffect(() => {
    const onUpdate = () => forceRender(n => n + 1)
    squad.on('update', onUpdate)
    return () => {
      squad.off('update', onUpdate)
    }
  }, [squad])

  const tabs = squad.tabs
  const activeIndex = Math.max(0, tabs.findIndex(t => t.id === activeId))
  const current = tabs[activeIndex]!
  const isNewTab = current.kind === 'new'
  const isEditing = editing !== undefined && editing === current.id
  const showingForm = isNewTab || isEditing

  useEffect(() => {
    squad.markSeen(current.id)
  }, [squad, current.id, squad.entries(current.id).length])

  const refreshTemplates = useCallback(() => {
    void listTemplates(
      squad.config.squadDir,
      squad.profiles().map(p => p.name),
    )
      .then(setTemplates)
      .catch(() => setTemplates([]))
  }, [squad])

  useEffect(() => {
    if (isNewTab) refreshTemplates()
  }, [isNewTab, refreshTemplates])

  const colorOf = useCallback(
    (name: string) => squad.profiles().find(a => a.name === name)?.color ?? 'white',
    [squad],
  )

  const startEditing = useCallback(
    (profile: AgentProfile) => {
      stashed.current = newAgent
      setNewAgent({
        phase: 'form',
        mode: 'edit',
        pickerIndex: 0,
        fieldIndex: 0,
        capIndex: 0,
        capabilities: [...profile.capabilities],
        draft: profileToDraft(profile),
        saveToLibrary: false,
      })
      setEditing(profile.name)
    },
    [newAgent],
  )

  const stopEditing = useCallback(() => {
    setNewAgent(stashed.current ?? initialNewAgentState())
    stashed.current = undefined
    setEditing(undefined)
  }, [])

  const quit = useCallback(async () => {
    setExiting(true)
    await squad.shutdown()
    exit()
  }, [squad, exit])

  const moveTab = useCallback(
    (delta: number) => {
      const list = squad.tabs
      const from = Math.max(0, list.findIndex(t => t.id === activeId))
      setActiveId(list[(from + delta + list.length) % list.length]!.id)
    },
    [squad, activeId],
  )

  const { rows, columns } = terminalSize(stdout?.rows, stdout?.columns)
  // The prompt sits in its own column, so the text wraps with a hanging indent under
  // itself rather than under the `@agent >` label.
  const promptLabel = current.id === GROUP_TAB ? '#groupchat ' : `@${current.id} `
  // One column is held back so a caret sitting on a trailing space still has somewhere
  // to draw.
  const inputWidth = Math.max(8, columns - promptLabel.length - 3)

  const draft = drafts[current.id] ?? composer.empty
  const setDraft = useCallback(
    (update: (previous: Composer) => Composer) => {
      setDrafts(prev => ({ ...prev, [current.id]: update(prev[current.id] ?? composer.empty) }))
    },
    [current.id],
  )

  const runCommand = useCallback(
    (line: string) => {
      const [command, ...rest] = line.slice(1).trim().split(/\s+/)
      const arg = rest[0]?.replace(/^@/, '')
      switch (command) {
        case 'help':
          setNotice(HELP)
          return
        case 'status':
          setNotice(
            squad.profiles().length === 0
              ? 'No agents yet. Open the + tab to add one.'
              : squad
                  .profiles()
                  .map(a => {
                    const ws = squad.workspaces.get(a.name)
                    const caps = a.capabilities.length > 0 ? `  [${a.capabilities.join(' ')}]` : ''
                    return `@${a.name}  ${describeStatus(squad.statusOf(a.name))}  ${ws?.branch ?? ws?.path ?? ''}${caps}`
                  })
                  .join('\n'),
          )
          return
        case 'cost': {
          const rows = squad.profiles().map(a => `@${a.name}  $${squad.costOf(a.name).toFixed(4)}`)
          setNotice([...rows, `total  $${squad.totalCost().toFixed(4)}`].join('\n'))
          return
        }
        case 'new':
          setActiveId(NEW_TAB)
          return
        case 'stop': {
          const target = arg ?? current.agent?.name
          if (!target) {
            setNotice('Usage: /stop <agent>')
            return
          }
          void squad.interrupt(target)
          setNotice(`Interrupting @${target}…`)
          return
        }
        case 'quit':
        case 'exit':
          void quit()
          return
        default:
          setNotice(`Unknown command "/${command}". Try /help.`)
      }
    },
    [squad, current, quit],
  )

  const submitForm = useCallback(() => {
    const { profile, error } = draftToProfile(newAgent.draft, squad.profiles().length, newAgent.capabilities)
    if (error || !profile) {
      setNewAgent(prev => ({ ...prev, error }))
      return
    }

    if (newAgent.mode === 'edit') {
      setNewAgent(prev => ({ ...prev, busy: true, error: undefined }))
      void squad
        .updateAgent(profile)
        .then(({ restarted }) => {
          stopEditing()
          setNotice(
            restarted
              ? `@${profile.name} updated. Its session restarted so the new setup applies; it was handed a summary of what it was doing.`
              : `@${profile.name} updated. No restart was needed.`,
          )
        })
        .catch((err: Error) => setNewAgent(prev => ({ ...prev, busy: false, error: err.message })))
      return
    }

    if (squad.hasAgent(profile.name)) {
      setNewAgent(prev => ({ ...prev, error: `@${profile.name} is already on the squad.` }))
      return
    }

    setNewAgent(prev => ({ ...prev, busy: true, error: undefined }))
    void squad
      .addAgent(profile, { alsoSaveToLibrary: newAgent.saveToLibrary })
      .then(() => {
        setNewAgent(initialNewAgentState())
        refreshTemplates()
        setActiveId(profile.name)
        setNotice(`@${profile.name} joined the squad.`)
      })
      .catch((err: Error) => {
        setNewAgent(prev => ({ ...prev, busy: false, error: err.message }))
      })
  }, [newAgent, squad, refreshTemplates, stopEditing])

  const handleFormKey = useCallback(
    (input: string, key: Key) => {
      if (newAgent.busy) return

      if (newAgent.phase === 'picker') {
        const rowCount = templates.length + 1
        if (key.upArrow) {
          setNewAgent(prev => ({ ...prev, pickerIndex: (prev.pickerIndex - 1 + rowCount) % rowCount }))
          return
        }
        if (key.downArrow) {
          setNewAgent(prev => ({ ...prev, pickerIndex: (prev.pickerIndex + 1) % rowCount }))
          return
        }
        if (key.return) {
          const template = newAgent.pickerIndex === 0 ? undefined : templates[newAgent.pickerIndex - 1]
          setNewAgent({
            phase: 'form',
            mode: 'new',
            pickerIndex: newAgent.pickerIndex,
            fieldIndex: 0,
            capIndex: 0,
            capabilities: template ? [...template.profile.capabilities] : [],
            draft: template ? profileToDraft(template.profile) : emptyDraft(),
            saveToLibrary: false,
          })
        }
        return
      }

      if (newAgent.phase === 'capabilities') {
        const list = capabilities
        if (key.escape || (key.ctrl && input === 'e')) {
          setNewAgent(prev => ({ ...prev, phase: 'form' }))
          return
        }
        if (key.ctrl && input === 's') {
          submitForm()
          return
        }
        if (key.upArrow) {
          setNewAgent(prev => ({ ...prev, capIndex: (prev.capIndex - 1 + Math.max(1, list.length)) % Math.max(1, list.length) }))
          return
        }
        if (key.downArrow) {
          setNewAgent(prev => ({ ...prev, capIndex: (prev.capIndex + 1) % Math.max(1, list.length) }))
          return
        }
        if (input === ' ' || key.return) {
          const chosen = list[newAgent.capIndex]
          if (!chosen) return
          setNewAgent(prev => ({
            ...prev,
            capabilities: prev.capabilities.includes(chosen.name)
              ? prev.capabilities.filter(c => c !== chosen.name)
              : [...prev.capabilities, chosen.name],
          }))
        }
        return
      }

      // Form phase.
      if (key.ctrl && input === 'e') {
        setNewAgent(prev => ({ ...prev, phase: 'capabilities', error: undefined }))
        return
      }
      if (key.escape) {
        if (newAgent.mode === 'edit') setEditing(undefined)
        else setNewAgent(prev => ({ ...prev, phase: 'picker', error: undefined }))
        return
      }
      if (key.ctrl && input === 's') {
        submitForm()
        return
      }
      if (key.ctrl && input === 'l') {
        setNewAgent(prev => ({ ...prev, saveToLibrary: !prev.saveToLibrary }))
        return
      }
      if (key.upArrow) {
        const n = editableFields(newAgent.mode).length
        setNewAgent(prev => ({ ...prev, fieldIndex: (prev.fieldIndex - 1 + n) % n }))
        return
      }
      if (key.downArrow) {
        const n = editableFields(newAgent.mode).length
        setNewAgent(prev => ({ ...prev, fieldIndex: (prev.fieldIndex + 1) % n }))
        return
      }

      const fields = editableFields(newAgent.mode)
      const field = fields[newAgent.fieldIndex]!
      const edit = (fn: (value: string) => string) =>
        setNewAgent(prev => ({ ...prev, draft: { ...prev.draft, [field]: fn(prev.draft[field]) }, error: undefined }))

      if (key.return) {
        // Enter writes a newline in the prompt body; elsewhere it just advances.
        if (field === 'instructions') edit(v => v + '\n')
        else
          setNewAgent(prev => ({
            ...prev,
            fieldIndex: Math.min(prev.fieldIndex + 1, editableFields(prev.mode).length - 1),
          }))
        return
      }
      if (key.backspace || key.delete) {
        edit(v => v.slice(0, -1))
        return
      }
      if (key.ctrl || key.meta || key.tab) return
      if (input) edit(v => v + input)
    },
    [newAgent, templates, capabilities, submitForm],
  )

  useInput((input, key) => {
    if (exiting) return

    // Mouse reports arrive as raw text. Every one is consumed here - including wheel and
    // release events we ignore - so none of it can end up typed into the composer.
    const mouse = parseMouse(input)
    if (mouse) {
      if (isLeftClick(mouse)) {
        const barTop = tabBar.top
        const barLeft = tabBar.left
        for (const [id, rect] of tabRects.current) {
          const absolute = { ...rect, top: barTop + rect.top, left: barLeft + rect.left }
          if (hitTest(absolute, mouse.col, mouse.row)) {
            setActiveId(id)
            break
          }
        }
      }
      return
    }

    if (key.ctrl && input === 'c') {
      void quit()
      return
    }
    if (key.ctrl && input === 'k') {
      const target = current.agent?.name
      if (target) void squad.interrupt(target)
      else void squad.interruptAll()
      setNotice(target ? `Interrupting @${target}…` : 'Interrupting every agent…')
      return
    }
    if (key.tab) {
      moveTab(key.shift ? -1 : 1)
      return
    }

    // An empty box means "navigate", a box with something in it means "edit". Arrows have
    // to move the caret once the composer can wrap - a box you cannot move around inside
    // is not really editable - but they are also the obvious way to change tabs, and Tab
    // alone is not enough when the composer is where your hands already are.
    const editing = !showingForm && draft.text.length > 0
    if ((key.leftArrow || key.rightArrow) && !editing) {
      moveTab(key.leftArrow ? -1 : 1)
      return
    }

    if (showingForm) {
      handleFormKey(input, key)
      return
    }

    // ^E opens the agent's configuration, but only from an empty box; with a draft in
    // progress it is end-of-line, which is what every other text box in a terminal does.
    if (key.ctrl && input === 'e' && !editing) {
      if (current.agent) startEditing(current.agent)
      return
    }

    // Composer.
    if (key.escape) {
      // Somewhere to put a notice that has been read. Startup warnings otherwise sat
      // above the composer for the life of the session with no way to clear them.
      setNotice(undefined)
      return
    }
    if (key.meta && (key.leftArrow || key.rightArrow)) {
      setDraft(key.leftArrow ? composer.moveWordLeft : composer.moveWordRight)
      return
    }
    if (key.leftArrow || key.rightArrow) {
      setDraft(key.leftArrow ? composer.moveLeft : composer.moveRight)
      return
    }
    if (key.ctrl && input === 'a') {
      setDraft(composer.lineStart)
      return
    }
    if (key.ctrl && input === 'e') {
      setDraft(composer.lineEnd)
      return
    }
    if (key.ctrl && input === 'd') {
      setDraft(composer.deleteForward)
      return
    }
    if (key.upArrow || key.downArrow) {
      // Once the draft occupies more than one row, up and down belong to it; history is
      // still one press away from the top or bottom row.
      if (composer.isMultiline(draft.text, inputWidth)) {
        const moved = composer.moveRow(draft, key.upArrow ? -1 : 1, inputWidth)
        if (moved !== draft) {
          setDraft(() => moved)
          return
        }
      }
      if (history.length === 0) return
      setHistoryIndex(prev => {
        const next =
          key.upArrow
            ? prev === undefined
              ? history.length - 1
              : Math.max(0, prev - 1)
            : prev === undefined
              ? undefined
              : Math.min(history.length - 1, prev + 1)
        setDraft(() => composer.withText(next === undefined ? '' : history[next] ?? ''))
        return next
      })
      return
    }
    if (key.return) {
      // A trailing backslash is the terminal convention for "keep going", and ⌥⏎ is what
      // the hosts that can send it use. Both have to work: a terminal that swallows the
      // modifier would otherwise leave no way at all to write a second line.
      const beforeCaret = draft.text.slice(0, draft.cursor)
      if (key.meta || key.shift) {
        setDraft(state => composer.insert(state, '\n'))
        return
      }
      if (beforeCaret.endsWith('\\')) {
        setDraft(state => composer.insert(composer.backspace(state), '\n'))
        return
      }
      const line = draft.text.trim()
      setDraft(() => composer.empty)
      setHistoryIndex(undefined)
      if (!line) return
      setNotice(undefined)
      setHistory(prev => (prev[prev.length - 1] === line ? prev : [...prev, line]).slice(-100))
      if (line.startsWith('/')) runCommand(line)
      else squad.submit(current.id, line)
      return
    }
    if (key.backspace || key.delete) {
      setDraft(composer.backspace)
      return
    }
    if (key.ctrl || key.meta) return
    if (input) setDraft(state => composer.insert(state, input))
  })

  const tabBar = useBoxMetrics(tabBarRef)
  // Wrapped rows, not `\n` count: a startup warning is one long sentence the box wraps
  // over four rows, so reserving one left the overflow riding on top of the composer.
  const noticeLines = noticeHeight(notice, columns)
  const noticeRows = useMemo(
    () => (notice ? composer.layoutInput(notice, 0, noticeWidth(columns)).lines : []),
    [notice, columns],
  )
  const caret = useMemo(
    () => composer.layoutInput(draft.text, draft.cursor, inputWidth),
    [draft.text, draft.cursor, inputWidth],
  )
  // The tab bar wraps onto extra rows when the terminal is narrow or the squad is large.
  // Measuring it - rather than assuming one row - is what keeps the app inside the
  // viewport; assuming pushed the title and the tabs off the top of a narrow terminal,
  // where they were simply gone.
  const { paneHeight, showTitle, showFooter, inputRows } = computeLayout({
    rows,
    tabBarHeight: tabBar.hasMeasured ? tabBar.height : 1,
    noticeLines,
    inputRows: caret.lines.length,
    showingForm,
  })
  // The caret has to stay on screen when the draft is taller than the rows it was given,
  // so the window follows it rather than always showing the top of the message.
  const firstRow = Math.max(0, Math.min(caret.row - inputRows + 1, caret.lines.length - inputRows))
  const visibleRows = caret.lines.slice(firstRow, firstRow + inputRows)

  const title = useMemo(() => squad.config.repoPath.split('/').filter(Boolean).pop() ?? 'repo', [squad])
  const agents = squad.profiles()

  return (
    // A hard ceiling on the whole app: whatever the layout does, Ink must never emit more
    // lines than the terminal has. If it does, the terminal scrolls and the top - the
    // title and the tab bar - is gone, with no way to scroll back to it.
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      {showTitle ? (
        <Box flexShrink={0} height={1} overflow="hidden">
          <Text bold wrap="truncate">
            claude-squad
          </Text>
          <Text dimColor wrap="truncate">
            {' '}
            {'─'} {title}
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="row" flexWrap="wrap" flexShrink={0} ref={tabBarRef}>
        {tabs.map(tab => {
          const isActive = tab.id === current.id
          const status = tab.agent ? squad.statusOf(tab.agent.name) : undefined
          const unseen = squad.unseenCount(tab.id)
          const color = tab.agent ? colorOf(tab.agent.name) : tab.kind === 'new' ? 'gray' : 'white'
          const suffix = `${status ? ` ${statusDot(status)}` : ''}${!isActive && unseen > 0 ? ` (${unseen})` : ''}`
          return (
            <TabLabel
              key={tab.id}
              label={tab.label}
              color={color}
              active={isActive}
              suffix={suffix}
              onMeasure={rect => tabRects.current.set(tab.id, rect)}
            />
          )
        })}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={showingForm ? 'cyan' : 'gray'}
        height={paneHeight + 2}
        overflow="hidden"
      >
        {showingForm ? (
          <AgentForm state={newAgent} templates={templates} capabilities={capabilities} />
        ) : (
          <Transcript
            entries={squad.entries(current.id)}
            colorOf={colorOf}
            height={paneHeight}
            width={columns - 2}
            // Only the groupchat mixes speakers; a one-to-one agent tab reads fine without gaps.
            speakerGap={current.id === GROUP_TAB ? 3 : 0}
          />
        )}
      </Box>

      {notice ? (
        <Box
          borderStyle="round"
          borderColor="blue"
          paddingX={1}
          flexDirection="column"
          flexShrink={0}
          overflow="hidden"
        >
          {noticeRows.slice(0, MAX_NOTICE_ROWS).map((line, i) => (
            <Text key={i} dimColor wrap="truncate">
              {line.text || ' '}
            </Text>
          ))}
          <Text dimColor italic wrap="truncate">
            {noticeRows.length > MAX_NOTICE_ROWS ? '… ' : ''}esc to dismiss
          </Text>
        </Box>
      ) : null}

      {showingForm ? null : (
        <Box flexShrink={0} height={inputRows} overflow="hidden">
          <Box flexShrink={0}>
            <Text color="cyan">{promptLabel}</Text>
            <Text>&gt; </Text>
          </Box>
          {/* The text lives in its own column so a wrapped line hangs under itself rather
              than under the `@agent >` label. */}
          <Box flexGrow={1} flexDirection="column" overflow="hidden">
            {visibleRows.map((line, i) => {
              const row = firstRow + i
              if (row !== caret.row) {
                return (
                  <Text key={row} wrap="truncate">
                    {line.text || ' '}
                  </Text>
                )
              }
              // The caret is drawn as an inverted cell on the character it sits on, so it
              // is visible wherever it is rather than only at the end of the draft.
              const col = caret.col
              return (
                <Text key={row} wrap="truncate">
                  {line.text.slice(0, col)}
                  <Text inverse>{line.text[col] ?? ' '}</Text>
                  {line.text.slice(col + 1)}
                </Text>
              )
            })}
          </Box>
        </Box>
      )}

      {showFooter ? (
        <Box flexDirection="row" flexShrink={0} height={1} overflow="hidden">
          {agents.length === 0 ? (
            <Text dimColor wrap="truncate">
              no agents yet {'─'} open the + tab to add one
            </Text>
          ) : (
            agents.map(agent => {
              const status = squad.statusOf(agent.name)
              return (
                <Box key={agent.name} marginRight={1} flexShrink={0}>
                  <Text color={statusColor(status)} dimColor={status.kind === 'idle'} wrap="truncate">
                    {agent.name}:{describeStatus(status)}
                  </Text>
                </Box>
              )
            })
          )}
          <Box flexGrow={1} justifyContent="flex-end" overflow="hidden">
            <Text dimColor wrap="truncate">
              {`$${squad.totalCost().toFixed(2)} · ←→ tabs · ^E config · ^K stop · ^C quit`}
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  )
}
