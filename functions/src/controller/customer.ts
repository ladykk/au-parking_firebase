import axios from "axios";
import * as functions from "firebase-functions";
import { Auth, Firestore } from "..";

// [Type/Function]
type LINEProfile = {
  [index: string]: string | undefined;
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
};
type Customer = {
  [index: string]: string | undefined;
  uid: string;
  displayName: string;
  photoUrl?: string;
};
function isProfileChange(
  user_profile: { displayName: string; photoUrl?: string },
  LINE_profile: LINEProfile
) {
  return (
    user_profile.displayName !== LINE_profile.displayName ||
    user_profile.photoUrl !== LINE_profile.pictureUrl
  );
}

// > Initializes modules.
const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const LINE_API = {
  verifyToken: {
    method: "GET",
    baseURL: "https://api.line.me/oauth2/v2.1/verify",
  },
  getProfile: {
    method: "GET",
    baseURL: "https://api.line.me/v2/profile",
  },
};

// > Sign in with LINE Provider. (Function)
exports.signInWithLINEProvider = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300 })
  .https.onCall(async (data, context) => {
    // Format parameters.
    const LINE_access_token: string = data;

    // CASE: no LINE access token.
    // DO: reject.
    if (!LINE_access_token)
      throw new functions.https.HttpsError(
        "invalid-argument",
        "require LINE access token."
      );

    // Verify LINE access token with LINE API.
    const LINE_verify_token = await axios({
      ...LINE_API.verifyToken,
      params: {
        access_token: LINE_access_token,
      },
    }).catch(() => {
      // CASE: cannot verify.
      // DO: reject.
      throw new functions.https.HttpsError(
        "unauthenticated",
        "cannot verify token."
      );
    });

    // CASE: token not from our channel.
    // DO: reject.
    if (LINE_verify_token.data.client_id !== LINE_LOGIN_CHANNEL_ID)
      throw new functions.https.HttpsError(
        "unauthenticated",
        "cannot verify token."
      );

    // Get profile from LINE API.
    const LINE_profile: LINEProfile = (
      await axios({
        ...LINE_API.getProfile,
        headers: {
          Authorization: `Bearer ${LINE_access_token}`,
        },
      }).catch((err) => {
        // CASE: cannot fetct LINE profile.
        // DO: reject.
        console.error(`cannot get LINE's profile.`);
        console.error(err);
        throw new functions.https.HttpsError(
          "internal",
          "something went wrong."
        );
      })
    ).data;

    // Get user from Authentication Service.
    const uid = `line:${LINE_profile.userId}`;
    let user = await Auth()
      .getUser(uid)
      .catch(() => {});

    // CASE: user not found.
    // DO: create new user, set  add to database.
    if (!user)
      // Create user on Authentication.
      user = await Auth()
        .createUser({
          uid: uid,
          displayName: LINE_profile.displayName,
          photoURL: LINE_profile.pictureUrl,
        })
        .then(async (user) => {
          // Set custom user claim.
          await Auth()
            .setCustomUserClaims(uid, { line: true })
            .catch((err) => {
              // CASE: cannot set custom user claims.
              // DO: reject.
              console.error(`cannot set custom user claims.`);
              console.error(err);
              throw new functions.https.HttpsError(
                "internal",
                "something went wrong."
              );
            });

          // Add customer into database.
          await Firestore()
            .collection("customers")
            .doc(uid)
            .set({
              uid: uid,
              displayName: LINE_profile.displayName,
              photoUrl: LINE_profile.pictureUrl,
            } as Customer)
            .catch((err) => {
              // CASE: cannot add customer into database.
              // DO: reject.
              console.error(`cannot add customer into database.`);
              console.error(err);
              throw new functions.https.HttpsError(
                "internal",
                "something went wrong."
              );
            });
          return user;
        })
        .catch((err) => {
          // CASE: cannot create user.
          // DO: reject.
          console.error(`cannot create user.`);
          console.error(err);
          throw new functions.https.HttpsError(
            "internal",
            "something went wrong."
          );
        });
    // Update profile if there is changes.
    // CASE: user found and there is changes.
    // DO: update user.
    else if (
      isProfileChange(
        { displayName: user.displayName as string, photoUrl: user.photoURL },
        LINE_profile
      )
    )
      // Update user on Authentication.
      user = await Auth()
        .updateUser(uid, {
          displayName: LINE_profile.displayName,
          photoURL: LINE_profile.pictureUrl,
        })
        .then(async (user) => {
          // Update user on database.
          await Firestore()
            .collection("customers")
            .doc(uid)
            .set(
              { displayName: user.displayName, photoUrl: user.photoURL },
              { merge: true }
            )
            .catch((err) => {
              // CASE: cannot update customer in database.
              // DO: reject.
              console.error(`cannot update customer in database.`);
              console.error(err);
              throw new functions.https.HttpsError(
                "internal",
                "something went wrong."
              );
            });
          return user;
        })
        .catch((err) => {
          // CASE: cannot update user.
          // DO: reject.
          console.error(`cannot update user.`);
          console.error(err);
          throw new functions.https.HttpsError(
            "internal",
            "something went wrong."
          );
        });

    // Generate and return custom token.
    const custom_token = await Auth()
      .createCustomToken(uid)
      .catch((err) => {
        // CASE: cannot generate custom token.
        // DO: reject.
        console.error(`cannot generate custom token.`);
        console.error(err);
        throw new functions.https.HttpsError(
          "internal",
          "something went wrong."
        );
      });
    return custom_token;
  });
