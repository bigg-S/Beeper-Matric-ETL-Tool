import * as sdk from "matrix-js-sdk";

const client = sdk.createClient({ baseUrl: "https://matrix.beeper.com" });

// const response = await client.login("m.login.password", {
//     user: "stevie-82399",
//     password: "icu14cu.Beeper"
// });

const redirectUrl = "http://localhost:3000";
const ssoUrl = client.getSsoLoginUrl(redirectUrl);



console.log(ssoUrl);

// The response will contain the tokens
// const accessToken = response.access_token;
// const refreshToken = response.refresh_token;

// console.log("Access token: ", accessToken);
// console.log("Refresh token: ", refreshToken);
