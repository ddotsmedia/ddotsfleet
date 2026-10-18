import Link from "next/link";

export default function Home() {
  return (
    <section>
      <h1>FleetOS</h1>
      <p>
        <Link href="/login">Driver sign-in</Link>
      </p>
    </section>
  );
}
