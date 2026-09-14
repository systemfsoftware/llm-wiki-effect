/**
 * `user.ask` form sanitizing.
 *
 * Ported from `sanitize_user_input_request` and its field/option helpers in
 * apps/desktop/src-tauri/src/agent/runtime.rs: model-authored markup is
 * stripped, ids are normalized to a portable key, and the shape is capped at
 * 12 fields with 8 options each so a model cannot push an unbounded form
 * through the protocol.
 */
import { Domain } from 'llm-wiki-protocol'
import { randomUUID } from 'node:crypto'
import { isRecord } from '../../json.js'

export const MAX_USER_INPUT_FIELDS = 12
export const MAX_USER_INPUT_OPTIONS = 8
export const MAX_USER_INPUT_TEXT_CHARS = 400

const cleanUserInputText = (value: string): string | undefined => {
  let cleaned = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '<' || char === '>' || code < 0x20) continue
    cleaned += char
  }
  cleaned = cleaned.trim()
  if (cleaned.length > MAX_USER_INPUT_TEXT_CHARS) {
    cleaned = cleaned.slice(0, MAX_USER_INPUT_TEXT_CHARS)
  }
  return cleaned === '' ? undefined : cleaned
}

const cleanUserId = (value: string): string | undefined => {
  let cleaned = ''
  for (const char of value) {
    cleaned += /[A-Za-z0-9_-]/.test(char) ? char : ''
  }
  return cleaned === '' ? undefined : cleaned
}

const normalizeFieldType = (value: string): string | undefined => {
  switch (value.trim()) {
    case 'single':
    case 'singleChoice':
    case 'radio':
    case 'select':
      return 'single'
    case 'multi':
    case 'multiChoice':
    case 'checkbox':
    case 'checkboxes':
      return 'multi'
    case 'text':
    case 'input':
      return 'text'
    case 'textarea':
    case 'longText':
      return 'textarea'
    case 'confirm':
    case 'boolean':
    case 'switch':
      return 'confirm'
    default:
      return undefined
  }
}

const uniqueKey = (used: Set<string>, base: string, index: number): string => {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let candidate = `${base}_${index + 1}`
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}_${index + 1}_${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

const firstString = (record: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

const sanitizeOption = (value: unknown): Domain.ChatUserInputOption | undefined => {
  if (!isRecord(value)) return undefined
  const label = cleanUserInputText(firstString(value, ['label', 'title']) ?? '')
  if (label === undefined) return undefined
  const rawValue = cleanUserInputText(firstString(value, ['value']) ?? '')
  const description = cleanUserInputText(firstString(value, ['description']) ?? '')
  const recommended = typeof value['recommended'] === 'boolean' ? value['recommended'] : undefined
  return new Domain.ChatUserInputOption({
    label,
    value: rawValue ?? label,
    ...(description === undefined ? {} : { description }),
    ...(recommended === undefined ? {} : { recommended }),
  })
}

const sanitizeField = (
  value: unknown,
  index: number,
): Domain.ChatUserInputField | undefined => {
  if (!isRecord(value)) return undefined
  const fieldType = normalizeFieldType(firstString(value, ['type', 'kind']) ?? 'single')
  if (fieldType === undefined) return undefined
  const id = cleanUserId(firstString(value, ['id', 'name']) ?? '') ?? `field_${index + 1}`
  const label = cleanUserInputText(firstString(value, ['label', 'question', 'header']) ?? '') ??
    `Question ${index + 1}`
  const description = cleanUserInputText(firstString(value, ['description']) ?? '')
  const placeholder = cleanUserInputText(firstString(value, ['placeholder']) ?? '')
  const usedOptionValues = new Set<string>()
  const rawOptions = Array.isArray(value['options']) ? value['options'] : []
  const options: Array<Domain.ChatUserInputOption> = []
  rawOptions.slice(0, MAX_USER_INPUT_OPTIONS).forEach((item, optionIndex) => {
    const option = sanitizeOption(item)
    if (option === undefined) return
    options.push(
      new Domain.ChatUserInputOption({
        label: option.label,
        value: uniqueKey(usedOptionValues, option.value, optionIndex),
        ...(option.description === undefined ? {} : { description: option.description }),
        ...(option.recommended === undefined ? {} : { recommended: option.recommended }),
      }),
    )
  })
  if ((fieldType === 'single' || fieldType === 'multi') && options.length === 0) return undefined
  const defaultValue = value['defaultValue'] ?? value['default']
  const accepted = defaultValue !== undefined &&
    (fieldType === 'text' || fieldType === 'textarea' ||
      (Array.isArray(defaultValue)
        ? defaultValue.every((item) => options.some((option) => option.value === item))
        : options.some((option) => option.value === defaultValue)))
  return new Domain.ChatUserInputField({
    id,
    type: fieldType,
    label,
    ...(description === undefined ? {} : { description }),
    ...(placeholder === undefined ? {} : { placeholder }),
    options,
    ...(accepted ? { defaultValue } : {}),
  })
}

export const sanitizeUserInputRequest = (
  action: {
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly fields?: unknown
    readonly questions?: unknown
  },
): Domain.ChatUserInputRequest | string => {
  const rawFields = action.fields ?? action.questions
  if (!Array.isArray(rawFields)) {
    return 'user.ask requires fields or questions'
  }
  const usedFieldIds = new Set<string>()
  const fields: Array<Domain.ChatUserInputField> = []
  rawFields.slice(0, MAX_USER_INPUT_FIELDS).forEach((value, index) => {
    const field = sanitizeField(value, index)
    if (field === undefined) return
    fields.push(
      new Domain.ChatUserInputField({
        id: uniqueKey(usedFieldIds, field.id, index),
        type: field.type,
        label: field.label,
        ...(field.description === undefined ? {} : { description: field.description }),
        ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
        options: field.options,
        ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
      }),
    )
  })
  if (fields.length === 0) return 'user.ask requires at least one valid field'
  const title = cleanUserInputText(action.title ?? 'Input required') ?? 'Input required'
  const description = cleanUserInputText(
    action.description ?? 'Please provide the requested information so the Agent can continue.',
  )
  return new Domain.ChatUserInputRequest({
    requestId: randomUUID(),
    title,
    ...(description === undefined ? {} : { description }),
    fields,
  })
}
