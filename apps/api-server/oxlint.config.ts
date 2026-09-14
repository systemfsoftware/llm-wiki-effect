import base from 'llm-wiki-oxlint-config/base'
import { defineConfig } from 'oxlint'

export default defineConfig({
  ...base,
  rules: {
    ...base.rules,
    'no-underscore-dangle': ['warn', { allow: ['_tag', '_id'] }],
  },
})
