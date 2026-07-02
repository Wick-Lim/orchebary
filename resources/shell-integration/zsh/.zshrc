if [[ -f "$ORB_USER_ZDOTDIR/.zshrc" ]]; then
  ZDOTDIR=$ORB_USER_ZDOTDIR
  . "$ORB_USER_ZDOTDIR/.zshrc"
  ZDOTDIR=$ORB_ZDOTDIR
fi
. "$ORB_ZDOTDIR/orchebary-integration.zsh"
