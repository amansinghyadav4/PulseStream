import { AuthLayout } from "./AuthLayout";
import { LoginForm } from "./forms";
import { navigateTo } from "../../lib/router";
import { IconArrowLeft } from "../icons";

export function LoginPage() {
  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back. Enter your credentials to access your workspace."
      back={
        // Explicit route navigation (not history.back()) so the control works on
        // a directly-opened /#/login URL with no previous entry to return to.
        <button type="button" className="auth-back" onClick={() => navigateTo("landing")}>
          <IconArrowLeft size={14} />
          Back to PulseStream
        </button>
      }
      footer={
        <>
          <span>
            New to PulseStream?{" "}
            <a href="#/signup" className="auth-link">
              Create an account
            </a>
          </span>
        </>
      }
    >
      <LoginForm />
    </AuthLayout>
  );
}
