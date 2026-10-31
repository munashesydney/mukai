import {
  registrationActions,
  registrationDescription,
  registrationInput,
} from '../custom-registration/shared';
export const registerCustomJobDefinition = {
  name: 'register_custom_job',
  title: 'Custom Job Registration',
  summary: 'Register and manage scheduled or workspace-start jobs from saved workspace modules.',
  description: registrationDescription('job'),
  inputSchema: registrationInput.omit({ permissionMode: true, presentation: true }).extend({
    operation: registrationInput.shape.operation.exclude(['set_permission', 'set_presentation']),
  }),
  actions: registrationActions.filter(
    (action) => action !== 'set_permission' && action !== 'set_presentation',
  ),
};
