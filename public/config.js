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
  // Browser-direct relay (wss://...); empty keeps the Lambda bridge.
  directWsUrl: '',
  // The PocketShell gateway that "via gateway" hosts dial (docs/gateway-client.md).
  gatewayServerUrl: 'wss://gateway.pocketshell.io',
  // Development ONLY — allows ws:// gateway URLs (a local or docker gateway).
  // Must stay false in production; it admits unencrypted gateway dials.
  gatewayAllowInsecureWs: false,
  // The trusted account service the browser exchanges the sign-in at for a
  // short-lived gateway credential. Frontend-owned trust — do not point it
  // anywhere you do not vouch for; gateway responses can never move it.
  syncApiBase: 'https://a7sota2qic.execute-api.eu-west-1.amazonaws.com',
};
