import { isAdminInitialized, resetAdminPassword } from "./store.mjs";

resetAdminPassword();
console.log(
  isAdminInitialized()
    ? "Não foi possível limpar a senha."
    : "Senha de administrador removida. Abra o painel para criar uma nova.",
);
