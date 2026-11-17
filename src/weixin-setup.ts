/** Executable entry for safe fresh-profile initialization. */
import { main } from './app/weixin-setup.ts'
try { main() } catch { console.error('Weixin setup failed: check paths, private credential permissions, state lock and whether the database already exists.');process.exitCode=1 }
