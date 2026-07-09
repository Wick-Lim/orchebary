if [[ -f "$ORB_USER_ZDOTDIR/.zshrc" ]]; then
  ZDOTDIR=$ORB_USER_ZDOTDIR
  . "$ORB_USER_ZDOTDIR/.zshrc"
  ZDOTDIR=$ORB_ZDOTDIR
fi
. "$ORB_ZDOTDIR/orchebary-integration.zsh"

# History must never land in the shipped shim directory.
if [[ -z "$HISTFILE" || "$HISTFILE" == "$ORB_ZDOTDIR"/* ]]; then
  HISTFILE="$ORB_USER_ZDOTDIR/.zsh_history"
fi
