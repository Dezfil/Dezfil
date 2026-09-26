"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ConnectionForm } from "./ConnectionForm";
import styles from "./NewConnectionScreen.module.css";

export function NewConnectionScreen() {
  const router = useRouter();
  return (
    <div className={styles.screen}>
      <Link className={styles.back} href="/connections">‹ Connections</Link>
      <section className={styles.card}>
        <ConnectionForm
          mode="add"
          onCancel={() => router.push("/connections")}
          onSaved={(connection) => router.push(`/connections/${connection.id}`)}
        />
      </section>
    </div>
  );
}
