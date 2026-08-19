/** Workspace application publication classification. */

import { describe, expect, it } from 'vitest'
import { isPrivateWorkspaceApplication } from './workspace-manifest-policy.ts'

describe('private workspace applications', () => {
  it('classifies private non-DeepSeek applications under apps', () => {
    expect(isPrivateWorkspaceApplication('apps/demand-platform', {
      name: 'demand-platform',
      private: true,
    })).toBe(true)
  })

  it('keeps official applications and packages in their release families', () => {
    expect(isPrivateWorkspaceApplication('apps/cli', {
      name: '@deepseek-ai/dsh',
      private: true,
    })).toBe(false)
    expect(isPrivateWorkspaceApplication('packages/demand/platform', {
      name: 'demand-platform',
      private: true,
    })).toBe(false)
  })

  it('does not exempt a publishable application manifest', () => {
    expect(isPrivateWorkspaceApplication('apps/demand-platform', {
      name: 'demand-platform',
      private: false,
    })).toBe(false)
  })
})
