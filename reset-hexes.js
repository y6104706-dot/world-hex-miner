// Simple script to reset all mined hexes
// Usage: node reset-hexes.js

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data')
const usersDataPath = path.join(dataDir, 'users.json')
const DEFAULT_START_HEX = '8b3f4dc1e26dfff'

console.log('Resetting mined hexes...')
console.log('Data directory:', dataDir)
console.log('Users file:', usersDataPath)

try {
  if (!fs.existsSync(usersDataPath)) {
    console.log('No users.json file found. Nothing to reset.')
    process.exit(0)
  }

  const raw = fs.readFileSync(usersDataPath, 'utf8')
  const data = JSON.parse(raw)

  if (!data.users || !Array.isArray(data.users)) {
    console.log('Invalid users.json format. Nothing to reset.')
    process.exit(0)
  }

  let resetCount = 0
  for (const user of data.users) {
    if (user.ownedHexes && Array.isArray(user.ownedHexes) && user.ownedHexes.length > 0) {
      const beforeCount = user.ownedHexes.length
      user.ownedHexes = [DEFAULT_START_HEX]
      if (beforeCount > 1) {
        resetCount++
        console.log(`Reset user ${user.email || user.id}: ${beforeCount} hexes -> 1 hex`)
      }
    }
  }

  fs.writeFileSync(usersDataPath, JSON.stringify(data, null, 2), 'utf8')
  console.log(`\n✓ Reset complete! ${resetCount} users reset.`)
  console.log(`All users now have only the default start hex: ${DEFAULT_START_HEX}`)
} catch (err) {
  console.error('Error resetting hexes:', err)
  process.exit(1)
}

