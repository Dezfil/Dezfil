import { Button } from "@/components/ui/Button";
import styles from "./EntryScreen.module.css";

/** The one action of an instance that signs people in through a sign-in
 * service. A plain form post: the answer takes the whole page on to the
 * service, a redirect a script's request could not follow to another site. */
export function StartSignIn({ label }: { label: string }) {
  return <form className={styles.form} method="post" action="/api/auth/external/start">
    <Button type="submit" variant="primary" size="chrome" className={styles.submit}>{label}</Button>
  </form>;
}
