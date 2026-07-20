import { describe, expect, it } from 'vitest'
import { distributionEnabled } from '../server/utils/distributionEnabled'

// The distribution feature gate is ON BY DEFAULT (dev stage); disabled ONLY when the env var is '0'.

describe('distributionEnabled', () => {
  it('is ON when the env var is unset (default)', () => {
    expect(distributionEnabled({} as NodeJS.ProcessEnv)).toBe(true)
  })
  it('is ON for any non-"0" value', () => {
    expect(distributionEnabled({ DISTRIBUTION_PROVISION_ENABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(distributionEnabled({ DISTRIBUTION_PROVISION_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(distributionEnabled({ DISTRIBUTION_PROVISION_ENABLED: '' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })
  it('is OFF only when explicitly "0"', () => {
    expect(distributionEnabled({ DISTRIBUTION_PROVISION_ENABLED: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false)
  })
})
