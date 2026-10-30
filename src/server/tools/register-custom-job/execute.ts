import {
  executeRegistration,
  type RegistrationContext,
  registrationInput,
} from '../custom-registration/shared';
import type { z } from 'zod';
export function executeRegisterCustomJob(
  input: z.infer<typeof registrationInput>,
  context: RegistrationContext,
  toolCallId: string,
) {
  return executeRegistration('job', input, context, toolCallId);
}
