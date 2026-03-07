import { createHash, randomBytes } from 'crypto'

export function generateApiKey(): string {
    return `rune_${randomBytes(24).toString('base64url')}`
}

export function hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex')
}

export function generateTenantId(): string {
    const b = randomBytes(16)
    b[6] = (b[6]! & 0x0f) | 0x40
    b[8] = (b[8]! & 0x3f) | 0x80
    const hex = b.toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
