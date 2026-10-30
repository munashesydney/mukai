import {
  registrationActions,
  registrationDescription,
  registrationInput,
} from '../custom-registration/shared';
export const registerCustomToolDefinition = {
  name: 'register_custom_tool',
  title: 'Custom Tool Registration',
  summary: 'Register and manage callable tools from saved workspace modules.',
  description: registrationDescription('tool'),
  inputSchema: registrationInput.extend({
    operation: registrationInput.shape.operation.exclude(['run_now']),
  }),
  actions: registrationActions.filter((action) => action !== 'run_now'),
};
