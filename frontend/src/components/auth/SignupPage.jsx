import { AuthLayout } from "./AuthLayout";
import { SignupForm } from "./forms";

export function SignupPage() {
  return (
    <AuthLayout
      title="Create your account"
      subtitle="Start monitoring your event pipeline in minutes."
      footer={
        <span>
          Already have an account?{" "}
          <a href="#/login" className="auth-link">
            Sign in
          </a>
        </span>
      }
    >
      <SignupForm />
    </AuthLayout>
  );
}
