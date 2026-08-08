import { z } from "zod";

/**
 * Request contract for the user-management route. It lives here rather than
 * inline in `app.ts` so the control plane and web client validate the same
 * shape, and so a schema failure renders as the shared 400 envelope.
 *
 * Only `admin` and `operator` are creatable: the owner comes from first-run
 * setup, and `player` accounts are not issued through this route.
 */
export const CreateUserRequestSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8),
  displayName: z.string().min(1).optional(),
  role: z.enum(["admin", "operator"]),
});

export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
