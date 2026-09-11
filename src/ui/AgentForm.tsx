import React from 'react'
import { Box, Text } from 'ink'
import type { Template } from '../library.js'

export const FIELDS = [
  'name',
  'displayName',
  'role',
  'model',
  'effort',
  'color',
  'budgetUsd',
  'instructions',
] as const

export type FieldKey = (typeof FIELDS)[number]

export const FIELD_LABELS: Record<FieldKey, string> = {
  name: 'handle',
  displayName: 'display name',
  role: 'role',
  model: 'model',
  effort: 'effort',
  color: 'color',
  budgetUsd: 'budget ($)',
  instructions: 'instructions',
}

export const FIELD_HINTS: Record<FieldKey, string> = {
  name: 'the @mention handle and branch name, e.g. engineer',
  displayName: 'shown on the tab',
  role: 'one line; teammates see this in the roster',
  model: 'blank uses the squad default',
  effort: 'low | medium | high | xhigh | max (blank = default)',
  color: 'green, cyan, magenta, yellow, blue, red',
  budgetUsd: 'hard spend cap; blank uses the squad default',
  instructions: 'the system prompt - Enter adds a newline',
}

export type Draft = Record<FieldKey, string>

export function emptyDraft(): Draft {
  return {
    name: '',
    displayName: '',
    role: '',
    model: '',
    effort: '',
    color: 'cyan',
    budgetUsd: '',
    instructions: '',
  }
}

export interface NewAgentState {
  phase: 'picker' | 'form'
  pickerIndex: number
  fieldIndex: number
  draft: Draft
  saveToLibrary: boolean
  error?: string
  busy?: boolean
}

export function initialNewAgentState(): NewAgentState {
  return { phase: 'picker', pickerIndex: 0, fieldIndex: 0, draft: emptyDraft(), saveToLibrary: false }
}

const SOURCE_LABEL: Record<Template['source'], string> = {
  builtin: 'built-in',
  library: 'library',
  project: 'this project',
}

function Picker({ templates, index }: { templates: Template[]; index: number }) {
  const rows = [{ id: 'blank', label: 'Blank agent', detail: 'start from scratch', source: undefined as Template['source'] | undefined }, ...templates]
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Add an agent</Text>
      <Text dimColor>Pick a starting point. {'↑↓'} move {'·'} Enter select {'·'} {'←→'} leave this tab</Text>
      <Box height={1} />
      {rows.map((row, i) => {
        const selected = i === index
        return (
          <Box key={row.id} flexDirection="row">
            <Box width={20} flexShrink={0}>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '\u276f ' : '  '}
                {row.label}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text dimColor wrap="wrap">
                {row.source ? `[${SOURCE_LABEL[row.source]}] ` : ''}
                {row.detail}
              </Text>
            </Box>
          </Box>
        )
      })}
      {templates.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No saved templates yet. Agents you save to the library appear here.</Text>
        </Box>
      ) : null}
    </Box>
  )
}

function Form({ state }: { state: NewAgentState }) {
  const { draft, fieldIndex, error, saveToLibrary, busy } = state
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>New agent</Text>
      <Text dimColor>
        {'↑↓'} field {'·'} type to edit {'·'} ^S save {'·'} ^L library:{' '}
        {saveToLibrary ? 'yes' : 'no'} {'·'} Esc back
      </Text>
      <Box height={1} />
      {FIELDS.map((field, i) => {
        const active = i === fieldIndex
        const value = draft[field]
        const multiline = field === 'instructions'
        const shown = multiline ? value.split('\n').slice(-6).join('\n') : value
        return (
          <Box key={field} flexDirection={multiline ? 'column' : 'row'}>
            <Box width={16}>
              <Text color={active ? 'cyan' : undefined} bold={active}>
                {active ? '❯ ' : '  '}
                {FIELD_LABELS[field]}
              </Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              <Text>
                {shown || <Text dimColor>{FIELD_HINTS[field]}</Text>}
                {active ? <Text inverse> </Text> : null}
              </Text>
            </Box>
          </Box>
        )
      })}
      {error ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}
      {busy ? (
        <Box marginTop={1}>
          <Text color="yellow">Creating the agent and its worktree{'…'}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export function AgentForm({ state, templates }: { state: NewAgentState; templates: Template[] }) {
  return state.phase === 'picker' ? (
    <Picker templates={templates} index={state.pickerIndex} />
  ) : (
    <Form state={state} />
  )
}
