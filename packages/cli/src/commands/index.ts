import type { Command } from '../command.ts'
import { pack } from './pack.ts'
import { packAlphaCommand } from './pack-alpha.ts'
import { validate } from './validate.ts'

/** Every command of the `ouaf` tool, in help order. */
export const COMMANDS: Command[] = [validate, pack, packAlphaCommand]
