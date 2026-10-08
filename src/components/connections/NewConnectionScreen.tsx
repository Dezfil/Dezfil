"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { RuledConnectionForm } from "./RuledConnectionForm";
import styles from "./NewConnectionScreen.module.css";

export function NewConnectionScreen() {
  const router = useRouter();
  return (
    <div className={styles.screen}>
      <Link className={styles.back} href="/connections">‹ Connections</Link>
      <section className={styles.card}>
        <RuledConnectionForm
          mode="add"
          onCancel={() => router.push("/connections")}
          onSaved={(connection) => router.push(`/connections/${connection.id}`)}
        />
      </section>
    </div>
  );
}
