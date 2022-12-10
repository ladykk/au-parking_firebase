import * as functions from "firebase-functions";
import { Auth, Firestore } from "../firebase";
import { WriteResult } from "@google-cloud/firestore";
import { UserRecord } from "firebase-functions/v1/auth";

// -> Staff functions

// [Staff]
type StaffRole = "Administrator" | "Staff";

type Staff = {
  [index: string]: string | boolean | undefined;
  email: string;
  role: StaffRole;
  displayName: string;
  phone_number: string;
  photoUrl?: string;
  disabled: boolean;
  add_by?: string;
};

type AddStaff = {
  [index: string]: string | File | null | undefined;
  email: string;
  password: string;
  role: StaffRole;
  displayName: string;
  phone_number: string;
  photoUrl?: string;
  add_by?: string;
};

type EditStaff = {
  [index: string]: string | boolean | undefined;
  displayName?: string;
  phone_number?: string;
  role?: string;
  disabled?: boolean;
  new_password?: string;
  photoUrl?: string;
};

// [Functions]
// F - Add staff.
exports.addStaff = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300 })
  .https.onCall(async (data, context) => {
    // Check is admin.
    // CASE: user is not admin.
    // DO: reject.
    if (!context.auth?.token.admin) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "required admin role."
      );
    }

    let user: UserRecord | undefined;
    let staff: WriteResult | undefined;
    try {
      // Check required fields on use_secret
      // CASE: missing required fields.
      // DO: reject.
      if (
        !data.displayName ||
        !data.email ||
        !data.phone_number ||
        !data.role ||
        !data.password ||
        !data.add_by
      ) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "missing required fields."
        );
      }

      //Format inputs
      const info: AddStaff = {
        displayName: data.displayName,
        email: data.email,
        phone_number: data.phone_number,
        role: data.role,
        photoUrl: data.photoUrl,
        password: data.password,
        add_by: data.add_by,
      };

      // Check if email is used.
      // CASE: user found with email.
      // DO: reject.
      const is_email_exist =
        (await Auth()
          .getUserByEmail(info.email)
          .catch(() => {})) || undefined;
      if (is_email_exist) {
        throw new functions.https.HttpsError(
          "already-exists",
          "email is used."
        );
      }

      // Format user info
      let user_info: any = {
        email: info.email,
        password: info.password,
        displayName: info.displayName,
      };
      if (info.photoUrl) user_info.photoUrl = info.photoUrl;

      // Create user.
      user = await Auth()
        .createUser(user_info)
        .catch((err) => {
          // CASE: cannot create user.
          // DO: reject.
          throw new functions.https.HttpsError(
            "internal",
            "cannot create user."
          );
        });

      // Set custom user claims.
      await Auth()
        .setCustomUserClaims(user.uid, {
          staff: info.role === "Administrator" || info.role === "Staff",
          admin: info.role === "Administrator",
        })
        .catch((err) => {
          // CASE: cannot set customer user claims.
          // DO: reject.
          throw new functions.https.HttpsError("internal", "cannot set role.");
        });

      // Add staff to database.
      const add_by = info.add_by
        ? Firestore().collection("staffs").doc(info.add_by)
        : undefined;
      await Firestore()
        .collection("staffs")
        .doc(info.email as string)
        .set({
          email: info.email,
          role: info.role,
          displayName: info.displayName,
          phone_number: info.phone_number,
          photoUrl: info.photoUrl,
          disabled: user.disabled,
          add_by: add_by,
        })
        .then((result) => (staff = result))
        .catch((err) => {
          // CASE: cannot add staff into database.
          // DO: reject.
          throw new functions.https.HttpsError("internal", "cannot add staff.");
        });

      return "OK.";
    } catch (e) {
      // CASE: user created or staff added into database.
      // DO: revert changes.
      if (user) await Auth().deleteUser(user.uid);
      if (user && staff)
        await Firestore().collection("staffs").doc(user.uid).delete();
      throw e;
    }
  });

// F - Edit staff.
exports.editStaff = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300 })
  .https.onCall(async (data, context) => {
    let old_user: UserRecord | undefined;
    let old_staff: Staff | undefined;
    let new_user: UserRecord | undefined;
    let new_staff: WriteResult | undefined;
    try {
      // Check credential (Staff/Admin)
      // CASE: no allow credential.
      // DO: reject.
      if (!context.auth?.token.staff) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "required staff role."
        );
      }

      // Check target_email.
      // CASE: no target_email.
      // DO: reject.
      const target_email: string | undefined = data.target_email;
      if (!target_email) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "missing target email."
        );
      }

      // Check if staff change other info.
      // CASE: staff change other info.
      // DO: reject
      if (
        !context.auth.token.admin &&
        context.auth.token.email !== target_email
      ) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "change other info."
        );
      }

      // Format changes.
      const changes: EditStaff = {};
      for (let attribute in data) {
        switch (attribute) {
          case "displayName":
          case "phone_number":
          case "role":
          case "new_password":
          case "photoUrl":
            if (data[attribute]) changes[attribute] = data[attribute];
            break;
          case "disabled":
            if (typeof data[attribute] === "boolean")
              changes[attribute] = data[attribute];
            break;
        }
      }

      // Check there is changes.
      // CASE: no changes.
      // DO: return.
      if (Object.keys(changes).length === 0) return;

      // Check restricted fields only Admin. (disabled, role)
      // CASE: conflict permission.
      // DO: reject.
      if (!context.auth.token.admin && (changes.disabled || changes.role)) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "change restricted field."
        );
      }

      // Get user with target_email.
      old_user = await Auth()
        .getUserByEmail(target_email)
        .catch(() => {
          // CASE: user not found.
          // DO: reject.
          throw new functions.https.HttpsError(
            "invalid-argument",
            "target email not found."
          );
        });

      // Change user's info.
      // CASE: cannot change user's info.
      // DO: reject.
      // -> displayName
      if (changes.displayName)
        new_user = await Auth()
          .updateUser(old_user.uid, { displayName: changes.displayName })
          .catch((err) => {
            throw new functions.https.HttpsError(
              "internal",
              "cannot change displayName."
            );
          });
      // -> disabled
      if (changes.disabled)
        new_user = await Auth()
          .updateUser(old_user.uid, {
            disabled: changes.disabled,
          })
          .catch((err) => {
            throw new functions.https.HttpsError(
              "internal",
              "cannot change disable."
            );
          });
      // -> disabled
      if (changes.photoUrl)
        new_user = await Auth()
          .updateUser(old_user.uid, {
            photoURL: changes.photoUrl,
          })
          .catch((err) => {
            throw new functions.https.HttpsError(
              "internal",
              "cannot change photoUrl."
            );
          });
      // -> new_password
      if (changes.new_password)
        new_user = await Auth()
          .updateUser(old_user.uid, {
            password: changes.new_password,
          })
          .catch((err) => {
            throw new functions.https.HttpsError(
              "internal",
              "cannot change password."
            );
          });

      // Get staff with target_email.
      const staff_ref = Firestore().collection("staffs").doc(target_email);
      old_staff = (await staff_ref.get()).data() as Staff;

      // Set staff with changes.
      new_staff = await staff_ref
        .set(
          {
            displayName: changes.displayName,
            phone_number: changes.phone_number,
            role: changes.role,
            photoUrl: changes.photoUrl,
            disabled: changes.disabled,
          },
          { merge: true }
        )
        .catch((err) => {
          // CASE: cannot update staff.
          throw new functions.https.HttpsError(
            "internal",
            "cannot update staff."
          );
        });

      return "OK.";
    } catch (e) {
      // CASE: user or staff updated.
      // DO: revert changes.
      if (old_user && new_user)
        await Auth().updateUser(old_user.uid, {
          displayName: old_user.displayName,
          photoURL: old_user.photoURL,
          disabled: old_user.disabled,
        });
      if (old_user && old_staff && new_staff)
        await Firestore().collection("staffs").doc(old_user.uid).set(old_staff);
      throw e;
    }
  });
