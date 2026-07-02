if [[ -f "$ORB_USER_ZDOTDIR/.zprofile" ]]; then
  ZDOTDIR=$ORB_USER_ZDOTDIR
  . "$ORB_USER_ZDOTDIR/.zprofile"
  ZDOTDIR=$ORB_ZDOTDIR
fi
