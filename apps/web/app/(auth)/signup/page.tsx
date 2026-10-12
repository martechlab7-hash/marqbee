import { AuthForm } from "@/components/auth-form";
export const metadata = { title: "Sign up" };
export default function Page() {
  return <AuthForm mode="signup" />;
}
