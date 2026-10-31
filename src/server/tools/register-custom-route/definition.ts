import {
  registrationActions,
  registrationDescription,
  registrationInput,
} from '../custom-registration/shared';
export const registerCustomRouteDefinition = {
  name: 'register_custom_route',
  title: 'Custom Route Registration',
  summary: 'Register and manage HTTP routes from saved workspace modules.',
  description: registrationDescription('route'),
  inputSchema: registrationInput.omit({ permissionMode: true, presentation: true }).extend({
    operation: registrationInput.shape.operation.exclude([
      'set_permission',
      'set_presentation',
      'run_now',
    ]),
  }),
  actions: registrationActions.filter(
    (action) =>
      action !== 'set_permission' && action !== 'set_presentation' && action !== 'run_now',
  ),
};
