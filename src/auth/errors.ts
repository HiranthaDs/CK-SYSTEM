export class PasswordUpdatedSignInError extends Error {
  readonly email: string

  constructor(email: string, cause?: unknown) {
    super('Your new password was saved, but automatic sign-in could not be completed. Sign in with the new password.')
    this.name = 'PasswordUpdatedSignInError'
    this.email = email
    this.cause = cause
  }
}
