import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const renames = [
  ['ProviderConfig', 'providerId', 'provider_id'],
  ['ProviderConfig', 'createdAt', 'created_at'],
  ['ProviderConfig', 'updatedAt', 'updated_at'],
  ['Voice', 'voiceId', 'voice_id'],
  ['Voice', 'previewMimeType', 'preview_mime_type'],
  ['Voice', 'previewAudio', 'preview_audio'],
  ['Voice', 'createdAt', 'created_at'],
  ['Voice', 'updatedAt', 'updated_at'],
  ['VoiceProviderLink', 'voiceRecordId', 'voice_record_id'],
  ['VoiceProviderLink', 'providerId', 'provider_id'],
  ['VoiceProviderLink', 'providerAccountId', 'provider_account_id'],
  ['VoiceProviderLink', 'providerVoiceId', 'provider_voice_id'],
  ['VoiceProviderLink', 'providerVoiceKey', 'provider_voice_key'],
  ['VoiceProviderLink', 'previewMimeType', 'preview_mime_type'],
  ['VoiceProviderLink', 'previewAudio', 'preview_audio'],
  ['VoiceProviderLink', 'createdAt', 'created_at'],
  ['VoiceProviderLink', 'updatedAt', 'updated_at'],
]

try {
  for (const [table, from, to] of renames) {
    await renameColumn(table, from, to)
  }
} finally {
  await prisma.$disconnect()
}

async function renameColumn(table, from, to) {
  const columns = await prisma.$queryRawUnsafe(
    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (?, ?)',
    table,
    from,
    to,
  )
  const names = new Set(columns.map(row => row.COLUMN_NAME))
  if (!names.has(from) || names.has(to)) return
  await prisma.$executeRawUnsafe(`ALTER TABLE \`${table}\` RENAME COLUMN \`${from}\` TO \`${to}\``)
  console.log(`Renamed ${table}.${from} to ${to}`)
}
