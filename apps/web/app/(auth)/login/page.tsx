import { AuthForm } from "@/components/auth-form";
export const metadata = { title: "Log in" };
export default function Page() {
  return <AuthForm mode="login" />;
}
