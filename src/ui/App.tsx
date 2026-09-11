import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout, type Key } from 'ink'
import { GROUP_TAB, NEW_TAB, describeStatus, type Squad } from '../squad.js'
import { Transcript } from './Transcript.js'
import { AgentForm, FIELDS, emptyDraft, initialNewAgentState, type NewAgentState } from './AgentForm.js'
import { listTemplates, type Template } from '../library.js'
import { draftToProfile, profileToDraft } from '../draft.js'
import type { AgentStatus } from '../types.js'

const HELP = [
  '← →            switch tabs (Tab also works)',
  '↑ ↓            input history (field / list in the + tab)',
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

export function App({ squad }: { squad: Squad }) {
  const { exit } = useApp()
  const { stdout } = useStdout()

  const [activeId, setActiveId] = useState(() => {
    const last = squad.lastTab
    return last && squad.tabs.some(t => t.id === last) ? last : GROUP_TAB
  })
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined)
  const [newAgent, setNewAgent] = useState<NewAgentState>(initialNewAgentState)
  const [templates, setTemplates] = useState<Template[]>([])
  const [, forceRender] = useState(0)
  const [notice, setNotice] = useState<string | undefined>(
    squad.warnings.length ? squad.warnings.join(' ') : undefined,
  )
  const [exiting, setExiting] = useState(false)

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

  const draft = drafts[current.id] ?? ''
  const setDraft = useCallback(
    (update: (previous: string) => string) => {
      setDrafts(prev => ({ ...prev, [current.id]: update(prev[current.id] ?? '') }))
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
                    return `@${a.name}  ${describeStatus(squad.statusOf(a.name))}  ${ws?.branch ?? ws?.path ?? ''}`
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

  const saveNewAgent = useCallback(() => {
    const { profile, error } = draftToProfile(newAgent.draft, squad.profiles().length)
    if (error || !profile) {
      setNewAgent(prev => ({ ...prev, error }))
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
  }, [newAgent, squad, refreshTemplates])

  const handleNewTabKey = useCallback(
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
            pickerIndex: newAgent.pickerIndex,
            fieldIndex: 0,
            draft: template ? profileToDraft(template.profile) : emptyDraft(),
            saveToLibrary: false,
          })
        }
        return
      }

      // Form phase.
      if (key.escape) {
        setNewAgent(prev => ({ ...prev, phase: 'picker', error: undefined }))
        return
      }
      if (key.ctrl && input === 's') {
        saveNewAgent()
        return
      }
      if (key.ctrl && input === 'l') {
        setNewAgent(prev => ({ ...prev, saveToLibrary: !prev.saveToLibrary }))
        return
      }
      if (key.upArrow) {
        setNewAgent(prev => ({ ...prev, fieldIndex: (prev.fieldIndex - 1 + FIELDS.length) % FIELDS.length }))
        return
      }
      if (key.downArrow) {
        setNewAgent(prev => ({ ...prev, fieldIndex: (prev.fieldIndex + 1) % FIELDS.length }))
        return
      }

      const field = FIELDS[newAgent.fieldIndex]!
      const edit = (fn: (value: string) => string) =>
        setNewAgent(prev => ({ ...prev, draft: { ...prev.draft, [field]: fn(prev.draft[field]) }, error: undefined }))

      if (key.return) {
        // Enter writes a newline in the prompt body; elsewhere it just advances.
        if (field === 'instructions') edit(v => v + '\n')
        else setNewAgent(prev => ({ ...prev, fieldIndex: Math.min(prev.fieldIndex + 1, FIELDS.length - 1) }))
        return
      }
      if (key.backspace || key.delete) {
        edit(v => v.slice(0, -1))
        return
      }
      if (key.ctrl || key.meta || key.tab) return
      if (input) edit(v => v + input)
    },
    [newAgent, templates, saveNewAgent],
  )

  useInput((input, key) => {
    if (exiting) return

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
    // Left/right always move between tabs, from every pane.
    if (key.leftArrow) {
      moveTab(-1)
      return
    }
    if (key.rightArrow) {
      moveTab(1)
      return
    }
    if (key.tab) {
      moveTab(key.shift ? -1 : 1)
      return
    }

    if (isNewTab) {
      handleNewTabKey(input, key)
      return
    }

    // Composer.
    if (key.upArrow || key.downArrow) {
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
        setDraft(() => (next === undefined ? '' : history[next] ?? ''))
        return next
      })
      return
    }
    if (key.return) {
      const line = draft.trim()
      setDraft(() => '')
      setHistoryIndex(undefined)
      if (!line) return
      setNotice(undefined)
      setHistory(prev => (prev[prev.length - 1] === line ? prev : [...prev, line]).slice(-100))
      if (line.startsWith('/')) runCommand(line)
      else squad.submit(current.id, line)
      return
    }
    if (key.backspace || key.delete) {
      setDraft(prev => prev.slice(0, -1))
      return
    }
    if (key.escape || key.ctrl || key.meta) return
    if (input) setDraft(prev => prev + input)
  })

  const rows = stdout?.rows ?? 24
  const noticeLines = notice ? notice.split('\n').length + 2 : 0
  const paneHeight = Math.max(4, rows - 8 - noticeLines)

  const title = useMemo(() => squad.config.repoPath.split('/').filter(Boolean).pop() ?? 'repo', [squad])
  const agents = squad.profiles()

  return (
    <Box flexDirection="column" width="100%">
      <Box>
        <Text bold>claude-squad</Text>
        <Text dimColor> {'─'} {title}</Text>
      </Box>

      <Box flexDirection="row" flexWrap="wrap">
        {tabs.map(tab => {
          const isActive = tab.id === current.id
          const status = tab.agent ? squad.statusOf(tab.agent.name) : undefined
          const unseen = squad.unseenCount(tab.id)
          const color = tab.agent ? colorOf(tab.agent.name) : tab.kind === 'new' ? 'gray' : 'white'
          return (
            <Box key={tab.id} marginRight={1}>
              <Text inverse={isActive} color={color} bold={isActive}>
                {' '}
                {tab.label}
                {status ? ` ${statusDot(status)}` : ''}
                {!isActive && unseen > 0 ? ` (${unseen})` : ''}{' '}
              </Text>
            </Box>
          )
        })}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={isNewTab ? 'cyan' : 'gray'}
        height={paneHeight + 2}
        overflow="hidden"
      >
        {isNewTab ? (
          <AgentForm state={newAgent} templates={templates} />
        ) : (
          <Transcript
            entries={squad.entries(current.id)}
            colorOf={colorOf}
            height={paneHeight}
            width={(stdout?.columns ?? 80) - 2}
          />
        )}
      </Box>

      {notice ? (
        <Box borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column">
          <Text dimColor>{notice}</Text>
        </Box>
      ) : null}

      {isNewTab ? null : (
        <Box>
          <Text color="cyan">{current.id === GROUP_TAB ? '#groupchat ' : `@${current.id} `}</Text>
          <Text>&gt; </Text>
          <Text>{draft}</Text>
          <Text inverse>{' '}</Text>
        </Box>
      )}

      <Box flexDirection="row">
        {agents.length === 0 ? (
          <Text dimColor>no agents yet {'─'} open the + tab to add one</Text>
        ) : (
          agents.map(agent => {
            const status = squad.statusOf(agent.name)
            return (
              <Box key={agent.name} marginRight={1}>
                <Text color={statusColor(status)} dimColor={status.kind === 'idle'}>
                  {agent.name}:{describeStatus(status)}
                </Text>
              </Box>
            )
          })
        )}
        <Box flexGrow={1} justifyContent="flex-end">
          <Text dimColor>
            {`$${squad.totalCost().toFixed(2)} · ←→ tabs · ^K stop · ^C quit`}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
