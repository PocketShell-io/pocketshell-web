// Runtime configuration, loaded before the app bundle. The deploy script
// (scripts/deploy.sh) rewrites this file from the stack outputs when values
// are provided, so rotations do not need a rebuild.
//
// googleClientId must be a Google "Web application" OAuth client with
// <site origin> (and http://localhost:5173 for dev) in its Authorized
// JavaScript origins. The desktop app's client is a different credential
// type and cannot issue browser tokens.
window.POCKETSHELL_WEB = {
  syncApiUrl: 'https://a7sota2qic.execute-api.eu-west-1.amazonaws.com',
  googleClientId: '1035162854462-kkqius5o2ni136ed6l58iig5pdpeh4u6.apps.googleusercontent.com',
  wsUrl: '',
};
