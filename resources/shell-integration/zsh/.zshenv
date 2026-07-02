# Orchebary shell-integration shim (VS Code-style ZDOTDIR injection).
# Sources the user's real .zshenv, then keeps ZDOTDIR pointed at this shim so
# zsh reads the remaining startup files from here.
ORB_ZDOTDIR=${ZDOTDIR:-$HOME}
if [[ -z "$ORB_USER_ZDOTDIR" ]]; then
  ORB_USER_ZDOTDIR=$HOME
fi
if [[ -f "$ORB_USER_ZDOTDIR/.zshenv" ]]; then
  ZDOTDIR=$ORB_USER_ZDOTDIR
  . "$ORB_USER_ZDOTDIR/.zshenv"
  # The user's .zshenv may itself relocate ZDOTDIR; respect that.
  ORB_USER_ZDOTDIR=${ZDOTDIR:-$ORB_USER_ZDOTDIR}
  ZDOTDIR=$ORB_ZDOTDIR
fi
