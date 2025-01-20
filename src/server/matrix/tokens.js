import * as sdk from "matrix-js-sdk";

const client = sdk.createClient({ baseUrl: "https://matrix.beeper.com" });

const response = await client.login("m.login.password", {
    user: "stephen-82399",
    password: "icu14cu.Beeper"
});

const accessToken = response.access_token;
const refreshToken = response.refresh_token;

console.log("Access token: ", accessToken);
console.log("Refresh token: ", refreshToken);
