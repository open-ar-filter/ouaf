import type { Command } from '../command.ts'
import { validate } from './validate.ts'

/** Every command of the `ouaf` tool, in help order. */
export const COMMANDS: Command[] = [validate]
