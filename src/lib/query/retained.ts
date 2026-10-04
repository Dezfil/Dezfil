/** Each compiled module copy registers its actual stores on the shared
 * deletion drain holder. Cleanup waits for physical settlement. */
export {
  registerRetainedStore as registerQueryStore,
  retentionGeneration as queryRetentionGeneration,
  purgeRetainedStores as purgeQueryStores,
  type RetainedStore as RetainedQueryStore,
} from "@/lib/auth/account-deletion-admission";
